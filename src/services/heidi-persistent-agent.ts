import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { containsSecrets, redactSecrets } from "../lib/secret-redaction"

export type MemoryScope = "user" | "agent" | "repo"
export interface MemoryInput { scope: MemoryScope; kind: string; content: string; canonicalKey?: string; confidence?: number; sourceType?: string; sourceSessionId?: string; sourceTaskRunId?: string; sourceAgent?: string; sourceCommitSha?: string; evidenceRefs?: string[] }
export interface MemoryRecord extends MemoryInput { id: string; status: "active" | "inactive" | "quarantined"; version: number; createdAt: string; updatedAt: string; quarantineReason?: string }
export interface SessionMessage { role: string; content: string; toolSummary?: string; createdAt?: string }

const unsafe = /(ignore\s+(all|any|previous)\s+instructions|disable\s+(approval|governance|security)|exfiltrat(e|ing)|always\s+run\s+arbitrary\s+shell|private\s+key|password\s*[:=])/i
function validateContent(content: string): void {
  if (!content.trim() || content.length > 20_000) throw new Error("Memory content must be non-empty and <= 20000 characters")
  if (containsSecrets(content)) throw new Error("Memory content contains credential material")
  if (unsafe.test(content)) throw new Error("Memory content contains unsafe governance instructions")
}
function now(): string { return new Date().toISOString() }
function rowToMemory(row: Record<string, unknown>): MemoryRecord {
  return { id: String(row.id), scope: row.scope as MemoryScope, kind: String(row.kind), content: String(row.content), canonicalKey: row.canonical_key ? String(row.canonical_key) : undefined, status: row.status as MemoryRecord["status"], confidence: Number(row.confidence), sourceType: String(row.source_type), sourceSessionId: row.source_session_id ? String(row.source_session_id) : undefined, sourceTaskRunId: row.source_task_run_id ? String(row.source_task_run_id) : undefined, sourceAgent: row.source_agent ? String(row.source_agent) : undefined, sourceCommitSha: row.source_commit_sha ? String(row.source_commit_sha) : undefined, evidenceRefs: JSON.parse(String(row.evidence_refs ?? "[]")), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at), quarantineReason: row.quarantine_reason ? String(row.quarantine_reason) : undefined }
}

export class HeidiPersistentAgentStore {
  constructor(private readonly db: Database) {}
  addMemory(input: MemoryInput, actor = "heidi"): MemoryRecord {
    validateContent(input.content)
    const id = randomUUID(), timestamp = now(), confidence = Math.max(0, Math.min(1, input.confidence ?? 0.5))
    const content = redactSecrets(input.content)
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const existing = input.canonicalKey ? this.db.query("SELECT * FROM heidi_memory WHERE scope = ? AND canonical_key = ?").get(input.scope, input.canonicalKey) as Record<string, unknown> | null : null
      const version = existing ? Number(existing.version) + 1 : 1
      if (existing) this.db.query("UPDATE heidi_memory SET content=?, confidence=?, status='active', version=?, updated_at=? WHERE id=?").run(content, confidence, version, timestamp, String(existing.id))
      else this.db.query("INSERT INTO heidi_memory (id,scope,kind,canonical_key,content,confidence,source_type,source_session_id,source_task_run_id,source_agent,source_commit_sha,evidence_refs,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, input.scope, input.kind, input.canonicalKey ?? null, content, confidence, input.sourceType ?? "explicit", input.sourceSessionId ?? null, input.sourceTaskRunId ?? null, input.sourceAgent ?? null, input.sourceCommitSha ?? null, JSON.stringify(input.evidenceRefs ?? []), version, timestamp, timestamp)
      const memoryId = existing ? String(existing.id) : id
      this.db.query("INSERT INTO heidi_memory_versions (id,memory_id,version,content,status,confidence,provenance,changed_at,changed_by) VALUES (?,?,?,?,?,?,?,?,?)").run(randomUUID(), memoryId, version, content, "active", confidence, JSON.stringify(input), timestamp, actor)
      this.db.query("INSERT INTO heidi_audit (id,event,subject_id,payload,created_at) VALUES (?,?,?,?,?)").run(randomUUID(), "memory_applied", memoryId, JSON.stringify({ scope: input.scope, version, actor }), timestamp)
      this.db.exec("COMMIT")
      return rowToMemory(this.db.query("SELECT * FROM heidi_memory WHERE id=?").get(memoryId) as Record<string, unknown>)
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  listMemory(scope?: MemoryScope, limit = 20): MemoryRecord[] {
    const rows = (scope ? this.db.query("SELECT * FROM heidi_memory WHERE scope=? AND status='active' ORDER BY confidence DESC, updated_at DESC LIMIT ?").all(scope, limit) : this.db.query("SELECT * FROM heidi_memory WHERE status='active' ORDER BY confidence DESC, updated_at DESC LIMIT ?").all(limit)) as Record<string, unknown>[]
    return rows.map(rowToMemory)
  }
  deactivateMemory(id: string): void { this.db.query("UPDATE heidi_memory SET status='inactive', updated_at=? WHERE id=?").run(now(), id) }
  history(id: string): unknown[] { return this.db.query("SELECT * FROM heidi_memory_versions WHERE memory_id=? ORDER BY version DESC").all(id) as unknown[] }
  rollbackMemory(id: string, version: number): MemoryRecord {
    const row = this.db.query("SELECT * FROM heidi_memory_versions WHERE memory_id=? AND version=?").get(id, version) as Record<string, unknown> | null
    if (!row) throw new Error("Memory version not found")
    const current = this.db.query("SELECT scope, canonical_key, kind FROM heidi_memory WHERE id=?").get(id) as { scope: MemoryScope; canonical_key?: string; kind: string } | null
    if (!current) throw new Error("Memory not found")
    return this.addMemory({ scope: current.scope, kind: current.kind, content: String(row.content), canonicalKey: current.canonical_key, confidence: Number(row.confidence), sourceType: "rollback" }, "heidi")
  }
  archiveSession(sessionId: string, messages: SessionMessage[], metadata: { source?: string; repository?: string; taskRunId?: string; agent?: string } = {}): void {
    const timestamp = now(); this.db.exec("BEGIN IMMEDIATE")
    try { this.db.query("INSERT OR IGNORE INTO heidi_session_archive (session_id,source,repository,task_run_id,agent,archived_at) VALUES (?,?,?,?,?,?)").run(sessionId, metadata.source ?? "opencode", metadata.repository ?? null, metadata.taskRunId ?? null, metadata.agent ?? null, timestamp); const insert = this.db.query("INSERT OR REPLACE INTO heidi_session_messages (id,session_id,sequence,role,content,tool_summary,created_at) VALUES (?,?,?,?,?,?,?)"); messages.forEach((m, i) => insert.run(randomUUID(), sessionId, i, m.role, redactSecrets(m.content).slice(0, 50_000), m.toolSummary ? redactSecrets(m.toolSummary).slice(0, 10_000) : null, m.createdAt ?? timestamp)); this.db.exec("COMMIT") } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  searchSessions(query: string, options: { repository?: string; sessionId?: string; limit?: number; offset?: number } = {}): unknown[] {
    const rawQuery = query.trim(); if (!rawQuery) return []
    const safeQuery = `"${rawQuery.replaceAll('"', '""')}"`
    const clauses = ["heidi_session_messages_fts MATCH ?"]; const params: (string | number)[] = [safeQuery]
    if (options.repository) { clauses.push("a.repository = ?"); params.push(options.repository) }; if (options.sessionId) { clauses.push("a.session_id = ?"); params.push(options.sessionId) }
    params.push(options.limit ?? 20, options.offset ?? 0)
    return this.db.query(`SELECT a.session_id, a.repository, a.archived_at, m.sequence, m.role, m.content, snippet(heidi_session_messages_fts, 0, '[', ']', '…', 24) AS match FROM heidi_session_messages_fts f JOIN heidi_session_messages m ON m.rowid=f.rowid JOIN heidi_session_archive a ON a.session_id=m.session_id WHERE ${clauses.join(" AND ")} ORDER BY a.archived_at DESC, m.sequence LIMIT ? OFFSET ?`).all(...params as (string | number)[]) as unknown[]
  }
}
