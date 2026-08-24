import type { Database } from "bun:sqlite"
import { randomUUID } from "crypto"
import type { RouterDecision } from "../../../services/heidi-fast-router"

export type DeferredReplacementStatus =
  | "pending_termination"
  | "resuming"
  | "resumed"
  | "superseded"
  | "blocked"

export interface DeferredReplacementRecord {
  id: string
  parentSessionId: string
  oldRunId: string
  sourceIntent: "REPLACE" | "MODIFY_RECLASSIFICATION"
  agentId: string
  effectiveGoal: string
  messageHash: string
  messageId: string
  correlationId: string
  routingDecision: RouterDecision
  status: DeferredReplacementStatus
  createdAt: string
  updatedAt: string
  resumedAt?: string
  replacementRunId?: string
  supersededById?: string
}

export interface SavePendingDeferredReplacementInput {
  parentSessionId: string
  oldRunId: string
  sourceIntent: "REPLACE" | "MODIFY_RECLASSIFICATION"
  agentId: string
  effectiveGoal: string
  messageHash: string
  messageId: string
  correlationId: string
  routingDecision: RouterDecision
}

export class SqliteDeferredReplacementRepository {
  constructor(private readonly db: Database) {}

  savePending(input: SavePendingDeferredReplacementInput): DeferredReplacementRecord {
    const now = new Date().toISOString()
    const id = "def-" + randomUUID()

    this.db.exec("BEGIN IMMEDIATE")
    try {
      // 1. Mark existing active pending/resuming records as superseded by the new replacement
      this.db.query(`
        UPDATE deferred_replacements
        SET status = 'superseded', superseded_by_id = ?, updated_at = ?
        WHERE parent_session_id = ? AND status IN ('pending_termination', 'resuming')
      `).run(id, now, input.parentSessionId)

      // 2. Insert new pending replacement
      this.db.query(`
        INSERT INTO deferred_replacements (
          id, parent_session_id, old_run_id, source_intent, agent_id,
          effective_goal, message_hash, message_id, correlation_id,
          routing_decision, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_termination', ?, ?)
      `).run(
        id,
        input.parentSessionId,
        input.oldRunId,
        input.sourceIntent,
        input.agentId,
        input.effectiveGoal,
        input.messageHash,
        input.messageId,
        input.correlationId,
        JSON.stringify(input.routingDecision),
        now,
        now
      )

      this.db.exec("COMMIT")

      return {
        id,
        parentSessionId: input.parentSessionId,
        oldRunId: input.oldRunId,
        sourceIntent: input.sourceIntent,
        agentId: input.agentId,
        effectiveGoal: input.effectiveGoal,
        messageHash: input.messageHash,
        messageId: input.messageId,
        correlationId: input.correlationId,
        routingDecision: input.routingDecision,
        status: "pending_termination",
        createdAt: now,
        updatedAt: now,
      }
    } catch (err) {
      try { this.db.exec("ROLLBACK") } catch {}
      throw err
    }
  }

  findCurrentForSession(parentSessionId: string): DeferredReplacementRecord | null {
    const row = this.db.query(`
      SELECT * FROM deferred_replacements
      WHERE parent_session_id = ? AND status IN ('pending_termination', 'resuming')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(parentSessionId) as any

    if (!row) return null
    return this.mapRow(row)
  }

  claimForResume(id: string): boolean {
    const now = new Date().toISOString()
    const res = this.db.query(`
      UPDATE deferred_replacements
      SET status = 'resuming', updated_at = ?
      WHERE id = ? AND status = 'pending_termination'
    `).run(now, id)

    return res.changes > 0
  }

  markResumed(id: string, replacementRunId?: string): boolean {
    const now = new Date().toISOString()
    const res = this.db.query(`
      UPDATE deferred_replacements
      SET status = 'resumed', replacement_run_id = ?, resumed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'resuming'
    `).run(replacementRunId ?? null, now, now, id)

    return res.changes > 0
  }

  markSuperseded(id: string, supersededById: string): boolean {
    const now = new Date().toISOString()
    const res = this.db.query(`
      UPDATE deferred_replacements
      SET status = 'superseded', superseded_by_id = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending_termination', 'resuming')
    `).run(supersededById, now, id)

    return res.changes > 0
  }

  listPendingReadyForResume(): DeferredReplacementRecord[] {
    const rows = this.db.query(`
      SELECT * FROM deferred_replacements
      WHERE status = 'pending_termination'
      ORDER BY created_at ASC
    `).all() as any[]

    return rows.map(r => this.mapRow(r))
  }

  private mapRow(row: any): DeferredReplacementRecord {
    let decision: RouterDecision
    try {
      decision = typeof row.routing_decision === "string" ? JSON.parse(row.routing_decision) : row.routing_decision
    } catch {
      decision = { executionClass: "STANDARD", reason: "parsed fallback", reasonCode: "FALLBACK", confidence: 0.5, forcedByExplicitSignal: false }
    }

    return {
      id: row.id,
      parentSessionId: row.parent_session_id,
      oldRunId: row.old_run_id,
      sourceIntent: row.source_intent,
      agentId: row.agent_id,
      effectiveGoal: row.effective_goal,
      messageHash: row.message_hash,
      messageId: row.message_id,
      correlationId: row.correlation_id,
      routingDecision: decision,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resumedAt: row.resumed_at ?? undefined,
      replacementRunId: row.replacement_run_id ?? undefined,
      supersededById: row.superseded_by_id ?? undefined,
    }
  }
}
