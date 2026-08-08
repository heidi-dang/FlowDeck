/**
 * Persistent SQLite repository for context_items table.
 */
import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../transaction-manager"
import { BaseRepository } from "./repository"

export interface ContextItemRow {
  id: string
  runId: string
  sessionId: string | null
  source: string
  priority: number
  category: string
  contentType: "inline_text" | "inline_json" | "reference"
  content: string | null
  immutableRef: string | null
  refType: "evidence" | "completion_decision" | "verification_result" | "assignment_result" | "event" | "session_summary" | null
  contentHash: string
  tokenEstimate: number
  isSummarised: boolean
  createdAt: string
  expiresAt: string | null
}

export interface CreateContextItemInput {
  id: string
  runId: string
  sessionId?: string | null
  source: string
  priority?: number
  category: string
  contentType: "inline_text" | "inline_json" | "reference"
  content?: string | null
  immutableRef?: string | null
  refType?: "evidence" | "completion_decision" | "verification_result" | "assignment_result" | "event" | "session_summary" | null
  contentHash: string
  tokenEstimate: number
  expiresAt?: string | null
}

export class SqliteContextItemRepository extends BaseRepository {
  constructor(db: Database, tx: TransactionManager) {
    super(db, tx)
  }

  create(input: CreateContextItemInput): ContextItemRow {
    return this.tx.write(() => {
      this.db.query(
        `INSERT INTO context_items (
          id, run_id, session_id, source, priority, category, content_type, content, 
          immutable_ref, ref_type, content_hash, token_estimate, is_summarised, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), ?)`
      ).run(
        input.id,
        input.runId,
        input.sessionId ?? null,
        input.source,
        input.priority ?? 0,
        input.category,
        input.contentType,
        input.content ?? null,
        input.immutableRef ?? null,
        input.refType ?? null,
        input.contentHash,
        input.tokenEstimate,
        input.expiresAt ?? null
      )
      return this.findById(input.id)!
    })
  }

  findById(id: string): ContextItemRow | undefined {
    const row = this.db.query("SELECT * FROM context_items WHERE id = ?").get(id) as Record<string, unknown> | undefined
    return row ? mapContextItemRow(row) : undefined
  }

  findByRunId(runId: string): ContextItemRow[] {
    const rows = this.db.query("SELECT * FROM context_items WHERE run_id = ? ORDER BY priority DESC, created_at ASC").all(runId) as Record<string, unknown>[]
    return rows.map(mapContextItemRow)
  }

  findBySessionId(sessionId: string): ContextItemRow[] {
    const rows = this.db.query("SELECT * FROM context_items WHERE session_id = ? ORDER BY priority DESC, created_at ASC").all(sessionId) as Record<string, unknown>[]
    return rows.map(mapContextItemRow)
  }

  delete(id: string): boolean {
    return this.tx.write(() => {
      const res = this.db.query("DELETE FROM context_items WHERE id = ?").run(id)
      return res.changes > 0
    })
  }
}

function mapContextItemRow(r: Record<string, unknown>): ContextItemRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    sessionId: (r.session_id as string) ?? null,
    source: r.source as string,
    priority: (r.priority as number) ?? 0,
    category: r.category as string,
    contentType: r.content_type as any,
    content: (r.content as string) ?? null,
    immutableRef: (r.immutable_ref as string) ?? null,
    refType: (r.ref_type as any) ?? null,
    contentHash: r.content_hash as string,
    tokenEstimate: (r.token_estimate as number) ?? 0,
    isSummarised: (r.is_summarised as number) === 1,
    createdAt: r.created_at as string,
    expiresAt: (r.expires_at as string) ?? null,
  }
}
