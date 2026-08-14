import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { HeidiPersistentAgentStore } from "./heidi-persistent-agent"

export type LearningType = "USER_MEMORY" | "AGENT_MEMORY" | "REPO_MEMORY" | "SKILL_PATCH" | "SKILL_CREATE" | "SKILL_REFERENCE_ADD" | "SKILL_CORRECTION" | "NO_ACTION"
export type LearningReviewOutcome = "NO_ACTION" | "INSUFFICIENT_EVIDENCE" | "DUPLICATE" | "REJECTED" | "POLICY_BLOCKED" | "CANDIDATE_CREATED" | "PERSISTENCE_FAILED"
const iso = () => new Date().toISOString()
export class HeidiLearningRuntime {
  private readonly memory: HeidiPersistentAgentStore
  constructor(private readonly db: Database) { this.memory = new HeidiPersistentAgentStore(db) }
  reviewCompletion(input: { completionKey: string; sessionId?: string; taskRunId?: string; repository?: string; verified: boolean; summary?: string; evidence?: string[]; policy?: "off" | "auto" | "review" }): { status: LearningReviewOutcome; candidateId?: string } {
    const existing = this.db.query("SELECT status,candidate_id FROM heidi_completion_reviews WHERE completion_key=?").get(input.completionKey) as { status: string; candidate_id?: string } | null
    if (existing) return { status: existing.status === "completed" ? (existing.candidate_id ? "CANDIDATE_CREATED" : "NO_ACTION") : "PERSISTENCE_FAILED", candidateId: existing.candidate_id }
    const now = iso(); const reviewId = randomUUID()
    this.db.query("INSERT INTO heidi_completion_reviews (id,completion_key,session_id,task_run_id,status,created_at) VALUES (?,?,?,?,?,?)").run(reviewId,input.completionKey,input.sessionId ?? null,input.taskRunId ?? null,"running",now)
    try {
      if (!input.verified) { this.db.query("UPDATE heidi_completion_reviews SET status='completed', completed_at=? WHERE id=?").run(iso(), reviewId); return { status: "INSUFFICIENT_EVIDENCE" } }
      const summary = (input.summary ?? "").trim()
      if (!summary || summary.length < 24 || /temporary|todo|speculation/i.test(summary)) { this.db.query("UPDATE heidi_completion_reviews SET status='completed', completed_at=? WHERE id=?").run(iso(), reviewId); return { status: "NO_ACTION" } }
      if (input.policy === "off") { this.db.query("UPDATE heidi_completion_reviews SET status='completed', completed_at=? WHERE id=?").run(iso(), reviewId); return { status: "POLICY_BLOCKED" } }
      const candidate = this.propose({ type: "AGENT_MEMORY", content: summary.slice(0, 4000), provenance: { completionKey: input.completionKey, repository: input.repository, verified: true }, evidence: input.evidence, confidence: 0.75, sessionId: input.sessionId, taskRunId: input.taskRunId }) as { id: string }
      if (input.policy === "auto") this.decide(candidate.id, "approve", "automatic-policy")
      this.db.query("UPDATE heidi_completion_reviews SET status='completed', candidate_id=?, completed_at=? WHERE id=?").run(candidate.id, iso(), reviewId)
      return { status: "CANDIDATE_CREATED", candidateId: candidate.id }
    } catch (error) { this.db.query("UPDATE heidi_completion_reviews SET status='failed', error=?, completed_at=? WHERE id=?").run(String(error), iso(), reviewId); return { status: "PERSISTENCE_FAILED" } }
  }
  propose(input: { type: LearningType; content: string; provenance: Record<string, unknown>; evidence?: string[]; confidence: number; sessionId?: string; taskRunId?: string }): unknown {
    if (input.type === "NO_ACTION") return { type: input.type, status: "ignored" }
    const id = randomUUID(); this.db.query("INSERT INTO heidi_learning_candidates (id,type,content,provenance,evidence,confidence,source_session_id,source_task_run_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, input.type, input.content, JSON.stringify(input.provenance), JSON.stringify(input.evidence ?? []), Math.max(0, Math.min(1, input.confidence)), input.sessionId ?? null, input.taskRunId ?? null, iso()); return this.db.query("SELECT * FROM heidi_learning_candidates WHERE id=?").get(id)
  }
  listPending(): unknown[] { return this.db.query("SELECT * FROM heidi_learning_candidates WHERE status='pending' ORDER BY created_at DESC").all() as unknown[] }
  decide(id: string, decision: "approve" | "reject", actor = "user"): unknown {
    const candidate = this.db.query("SELECT * FROM heidi_learning_candidates WHERE id=? AND status='pending'").get(id) as Record<string, unknown> | null; if (!candidate) throw new Error("Pending learning candidate not found")
    const status = decision === "approve" ? "approved" : "rejected"; this.db.query("UPDATE heidi_learning_candidates SET status=?, decided_at=?, decision_by=? WHERE id=?").run(status, iso(), actor, id); this.db.query("INSERT INTO heidi_learning_events (id,candidate_id,event,payload,created_at) VALUES (?,?,?,?,?)").run(randomUUID(), id, status, JSON.stringify({ actor }), iso())
    if (decision === "approve") { const scope = candidate.type === "USER_MEMORY" ? "user" : candidate.type === "REPO_MEMORY" ? "repo" : "agent"; const applied = this.memory.addMemory({ scope: scope as "user" | "agent" | "repo", kind: String(candidate.type), content: String(candidate.content), sourceType: "learning_candidate", sourceSessionId: candidate.source_session_id ? String(candidate.source_session_id) : undefined, sourceTaskRunId: candidate.source_task_run_id ? String(candidate.source_task_run_id) : undefined, confidence: Number(candidate.confidence), evidenceRefs: JSON.parse(String(candidate.evidence ?? "[]")) }, "learning-curator"); this.db.query("UPDATE heidi_learning_candidates SET status='applied', applied_id=? WHERE id=?").run(applied.id, id); return applied }
    return candidate
  }
  history(): unknown[] { return this.db.query("SELECT * FROM heidi_learning_candidates ORDER BY created_at DESC").all() as unknown[] }
  rollback(id: string): void { this.db.query("UPDATE heidi_learning_candidates SET status='rolled_back' WHERE id=?").run(id); const row = this.db.query("SELECT applied_id FROM heidi_learning_candidates WHERE id=?").get(id) as { applied_id?: string } | null; if (row?.applied_id) this.memory.deactivateMemory(row.applied_id) }
}

export class HeidiSkillStore {
  constructor(private readonly db: Database) {}
  list(): unknown[] { return this.db.query("SELECT id,name,description,ownership,status,version,confidence,uses,success_count,failure_count,metadata FROM heidi_learned_skills WHERE status='active' ORDER BY ownership,name").all() as unknown[] }
  create(name: string, description: string, content: string, metadata: Record<string, unknown> = {}, ownership: "user" | "project" | "learned" = "learned"): unknown { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || /fix-[a-z]+-\d+|today|error-/.test(name)) throw new Error("Skill name must be a reusable kebab-case umbrella name"); if (!content.includes("When to use") || !content.includes("Verification")) throw new Error("Skill requires When to use and Verification sections"); const id = randomUUID(), now = iso(); this.db.query("INSERT INTO heidi_learned_skills (id,name,description,ownership,content,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id,name,description,ownership,content,JSON.stringify(metadata),now,now); this.db.query("INSERT INTO heidi_skill_versions (id,skill_id,version,content,metadata,changed_at,changed_by) VALUES (?,?,?,?,?,?,?)").run(randomUUID(),id,1,content,JSON.stringify(metadata),now,"learning-curator"); return this.db.query("SELECT * FROM heidi_learned_skills WHERE id=?").get(id) }
  view(name: string): unknown { return this.db.query("SELECT * FROM heidi_learned_skills WHERE name=? AND status='active'").get(name) }
  recordUse(name: string, success: boolean): void { this.db.query(`UPDATE heidi_learned_skills SET uses=uses+1, ${success ? "success_count" : "failure_count"}=${success ? "success_count" : "failure_count"}+1, updated_at=? WHERE name=?`).run(iso(), name) }
}
