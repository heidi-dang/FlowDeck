import type { Database } from "bun:sqlite"
import { randomUUID } from "crypto"
import type { RouterDecision } from "../../../services/heidi-fast-router"
import type { Run } from "../../types/runs"

export type DeferredReplacementStatus =
  | "pending_termination"
  | "resuming"
  | "handoff_pending"
  | "handoff_outcome_unknown"
  | "resumed"
  | "superseded"
  | "blocked"
  | "cancelled"

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
      // 1. Mark existing active pending/resuming/handoff/blocked records as superseded by the new replacement
      this.db.query(`
        UPDATE deferred_replacements
        SET status = 'superseded', superseded_by_id = ?, updated_at = ?
        WHERE parent_session_id = ? AND status IN ('pending_termination', 'resuming', 'handoff_pending', 'handoff_outcome_unknown', 'blocked')
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
      WHERE parent_session_id = ? AND status IN ('pending_termination', 'resuming', 'handoff_pending', 'handoff_outcome_unknown', 'blocked')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(parentSessionId) as any

    if (!row) return null
    try { return this.mapRow(row) } catch { return null }
  }

  findById(id: string): DeferredReplacementRecord | null {
    const row = this.db.query(`
      SELECT * FROM deferred_replacements
      WHERE id = ?
    `).get(id) as any

    if (!row) return null
    try { return this.mapRow(row) } catch { return null }
  }

  claimForResume(id: string): boolean {
    const now = new Date().toISOString()
    const res = this.db.query(`
      UPDATE deferred_replacements
      SET status = 'resuming', updated_at = ?
      WHERE id = ? AND status IN ('pending_termination', 'handoff_pending')
    `).run(now, id)

    return res.changes > 0
  }

  markHandoffPending(id: string, replacementRunId?: string): boolean {
    const now = new Date().toISOString()
    const res = this.db.query(`
      UPDATE deferred_replacements
      SET status = 'handoff_pending', replacement_run_id = COALESCE(?, replacement_run_id), updated_at = ?
      WHERE id = ? AND status IN ('resuming', 'pending_termination')
    `).run(replacementRunId ?? null, now, id)

    return res.changes > 0
  }

  markHandoffOutcomeUnknown(id: string): boolean {
    const now = new Date().toISOString()
    const res = this.db.query(`
      UPDATE deferred_replacements
      SET status = 'handoff_outcome_unknown', updated_at = ?
      WHERE id = ? AND status IN ('resuming', 'handoff_pending')
    `).run(now, id)

    return res.changes > 0
  }

  markResumed(id: string, replacementRunId?: string): boolean {
    const now = new Date().toISOString()
    const res = this.db.query(`
      UPDATE deferred_replacements
      SET status = 'resumed', replacement_run_id = COALESCE(?, replacement_run_id), resumed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('resuming', 'handoff_pending')
    `).run(replacementRunId ?? null, now, now, id)

    return res.changes > 0
  }

  markBlocked(id: string): boolean {
    const now = new Date().toISOString()
    const res = this.db.query(`
      UPDATE deferred_replacements
      SET status = 'blocked', updated_at = ?
      WHERE id = ? AND status IN ('pending_termination', 'resuming', 'handoff_pending')
    `).run(now, id)

    return res.changes > 0
  }

  markSuperseded(id: string, supersededById: string): boolean {
    const now = new Date().toISOString()
    const res = this.db.query(`
      UPDATE deferred_replacements
      SET status = 'superseded', superseded_by_id = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending_termination', 'resuming', 'handoff_pending', 'handoff_outcome_unknown', 'blocked')
    `).run(supersededById, now, id)

    return res.changes > 0
  }

  markCancelled(id: string): boolean {
    const now = new Date().toISOString()
    const res = this.db.query(`
      UPDATE deferred_replacements
      SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status IN ('pending_termination', 'resuming', 'handoff_pending', 'handoff_outcome_unknown', 'blocked')
    `).run(now, id)

    return res.changes > 0
  }

  cancelCurrentForSession(parentSessionId: string): boolean {
    const now = new Date().toISOString()
    const res = this.db.query(`
      UPDATE deferred_replacements
      SET status = 'cancelled', updated_at = ?
      WHERE parent_session_id = ? AND status IN ('pending_termination', 'resuming', 'handoff_pending', 'handoff_outcome_unknown', 'blocked')
    `).run(now, parentSessionId)

    return res.changes > 0
  }

  listPendingReadyForResume(): DeferredReplacementRecord[] {
    try {
      const rows = this.db.query(`
        SELECT * FROM deferred_replacements
        WHERE status = 'pending_termination'
           OR (status = 'handoff_pending' AND id NOT IN (
             SELECT SUBSTR(state_fingerprint, 17) FROM continuation_dispatches
             WHERE state_fingerprint LIKE 'deferred_resume:%'
               AND (status IN ('outcome_unknown', 'blocked') OR (status = 'failed' AND attempt_count >= 2))
           ))
        ORDER BY created_at ASC
      `).all() as any[]

      return rows.flatMap(row => {
        try { return [this.mapRow(row)] } catch { return [] }
      })
    } catch {
      return []
    }
  }

  listResuming(): DeferredReplacementRecord[] {
    try {
      const rows = this.db.query(`
        SELECT * FROM deferred_replacements
        WHERE status = 'resuming'
        ORDER BY created_at ASC
      `).all() as any[]

      return rows.flatMap(row => {
        try { return [this.mapRow(row)] } catch { return [] }
      })
    } catch {
      return []
    }
  }

  /**
   * Reconciles crash-surviving records on startup:
   * 1. For each record with status = 'resuming':
   *    - Checks if a replacement Run was already created with its correlationId.
   *    - If Run exists -> transitions resuming -> resumed with actual replacement_run_id.
   *    - If no Run exists -> safely returns to pending_termination so resume can proceed.
   */
  reconcileAfterRestart(
    runLookup?: (correlationId: string) => Run | null
  ): { recoveredResumed: number; recoveredPending: number; recoveredOutcomeUnknown: number } {
    const resumingRecords = this.listResuming()
    let recoveredResumed = 0
    let recoveredPending = 0
    let recoveredOutcomeUnknown = 0
    const now = new Date().toISOString()

    // 1. Reconcile any handoff_pending records that crashed during handoff
    try {
      const pendingHandoffRows = this.db.query(`
        SELECT id FROM deferred_replacements WHERE status = 'handoff_pending'
      `).all() as { id: string }[]
      for (const row of pendingHandoffRows) {
        // Inspect continuation_dispatches status
        const dispatchRow = this.db.query(`
          SELECT status, attempt_count FROM continuation_dispatches
          WHERE state_fingerprint = ?
          ORDER BY created_at DESC
          LIMIT 1
        `).get(`deferred_resume:${row.id}`) as { status: string; attempt_count: number } | null

        if (dispatchRow?.status === "dispatched") {
          this.db.query(`
            UPDATE deferred_replacements
            SET status = 'resumed', resumed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'handoff_pending'
          `).run(now, now, row.id)
          recoveredResumed++
        } else if (dispatchRow?.status === "outcome_unknown") {
          this.db.query(`
            UPDATE deferred_replacements
            SET status = 'handoff_outcome_unknown', updated_at = ?
            WHERE id = ? AND status = 'handoff_pending'
          `).run(now, row.id)
          recoveredOutcomeUnknown++
        } else if (dispatchRow?.status === "blocked" || (dispatchRow?.status === "failed" && dispatchRow.attempt_count >= 2)) {
          this.db.query(`
            UPDATE deferred_replacements
            SET status = 'blocked', updated_at = ?
            WHERE id = ? AND status = 'handoff_pending'
          `).run(now, row.id)
        } else if (dispatchRow?.status === "failed" && dispatchRow.attempt_count < 2) {
          // Known failed with retry attempts remaining: keep status='handoff_pending' so startup drain can retry dispatch
        } else {
          // No dispatch row yet (crashed before claim inserted): keep handoff_pending so startup drain can resume
        }
      }
    } catch {}

    // 2. Reconcile records stuck in 'resuming'
    for (const record of resumingRecords) {
      if (record.routingDecision.executionClass === "FAST_DIRECT") {
        // Check if dispatch was already completed
        const dispatchRow = this.db.query(`
          SELECT status FROM continuation_dispatches
          WHERE state_fingerprint = ?
          ORDER BY created_at DESC
          LIMIT 1
        `).get(`deferred_resume:${record.id}`) as { status: string } | null

        if (dispatchRow?.status === "dispatched") {
          this.db.query(`
            UPDATE deferred_replacements
            SET status = 'resumed', resumed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'resuming'
          `).run(now, now, record.id)
          recoveredResumed++
        } else if (dispatchRow?.status === "outcome_unknown") {
          this.db.query(`
            UPDATE deferred_replacements
            SET status = 'handoff_outcome_unknown', updated_at = ?
            WHERE id = ? AND status = 'resuming'
          `).run(now, record.id)
          recoveredOutcomeUnknown++
        } else {
          // Revert to pending_termination so fresh startup can safely claim and perform native handoff
          this.db.query(`
            UPDATE deferred_replacements
            SET status = 'pending_termination', updated_at = ?
            WHERE id = ? AND status = 'resuming'
          `).run(now, record.id)
          recoveredPending++
        }
        continue
      }

      // Orchestrated: Check SQLite execution_metadata and task_runs table synchronously
      let existingRunId: string | null = null
      if (runLookup) {
        const found = runLookup(record.correlationId)
        if (found) existingRunId = found.id
      }
      if (!existingRunId) {
        const metaRow = this.db.query(
          "SELECT run_id FROM execution_metadata WHERE key = ? LIMIT 1"
        ).get("run_correlation:" + record.correlationId) as { run_id: string } | null
        if (metaRow?.run_id) {
          existingRunId = metaRow.run_id
        } else {
          const eventRow = this.db.query(
            "SELECT aggregate_id FROM events WHERE correlation_id = ? AND aggregate_type = 'task_run' LIMIT 1"
          ).get(record.correlationId) as { aggregate_id: string } | null
          if (eventRow?.aggregate_id) {
            existingRunId = eventRow.aggregate_id
          } else {
            const runRow = this.db.query(
              "SELECT run_id FROM task_runs WHERE run_id = ? LIMIT 1"
            ).get(record.correlationId) as { run_id: string } | null
            if (runRow?.run_id) {
              existingRunId = runRow.run_id
            }
          }
        }
      }

      if (existingRunId) {
        // Run was created before crash. Inspect continuation_dispatches to check if native handoff was confirmed
        const dispatchRow = this.db.query(`
          SELECT status FROM continuation_dispatches
          WHERE state_fingerprint = ?
          ORDER BY created_at DESC
          LIMIT 1
        `).get(`deferred_resume:${record.id}`) as { status: string } | null

        if (dispatchRow?.status === "dispatched") {
          this.db.query(`
            UPDATE deferred_replacements
            SET status = 'resumed', replacement_run_id = ?, resumed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'resuming'
          `).run(existingRunId, now, now, record.id)
          recoveredResumed++
        } else if (dispatchRow?.status === "outcome_unknown") {
          this.db.query(`
            UPDATE deferred_replacements
            SET status = 'handoff_outcome_unknown', replacement_run_id = ?, updated_at = ?
            WHERE id = ? AND status = 'resuming'
          `).run(existingRunId, now, record.id)
          recoveredOutcomeUnknown++
        } else if (dispatchRow?.status === "blocked") {
          this.db.query(`
            UPDATE deferred_replacements
            SET status = 'blocked', replacement_run_id = ?, updated_at = ?
            WHERE id = ? AND status = 'resuming'
          `).run(existingRunId, now, record.id)
        } else {
          // Run exists but native prompt handoff was not confirmed: keep replacement_run_id and revert to pending_termination for startup handoff
          this.db.query(`
            UPDATE deferred_replacements
            SET status = 'pending_termination', replacement_run_id = ?, updated_at = ?
            WHERE id = ? AND status = 'resuming'
          `).run(existingRunId, now, record.id)
          recoveredPending++
        }
      } else {
        // No Run was created before crash: revert to pending_termination
        this.db.query(`
          UPDATE deferred_replacements
          SET status = 'pending_termination', replacement_run_id = NULL, updated_at = ?
          WHERE id = ? AND status = 'resuming'
        `).run(now, record.id)
        recoveredPending++
      }
    }

    return { recoveredResumed, recoveredPending, recoveredOutcomeUnknown }
  }

  private mapRow(row: any): DeferredReplacementRecord {
    try {
      const decision: unknown = typeof row.routing_decision === "string" ? JSON.parse(row.routing_decision) : row.routing_decision
      const requiredStrings = [
        row.id, row.parent_session_id, row.old_run_id, row.agent_id, row.effective_goal,
        row.message_hash, row.message_id, row.correlation_id, row.created_at, row.updated_at,
      ]
      if (requiredStrings.some(value => typeof value !== "string" || value.length === 0)) throw new Error("required_field")
      if (row.source_intent !== "REPLACE" && row.source_intent !== "MODIFY_RECLASSIFICATION") throw new Error("source_intent")
      if (![
        "pending_termination", "resuming", "handoff_pending", "handoff_outcome_unknown",
        "resumed", "superseded", "blocked", "cancelled",
      ].includes(row.status)) throw new Error("status")
      if (!this.isValidRoutingDecision(decision)) throw new Error("routing_decision")

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
    } catch (error) {
      this.quarantineCorruptActiveRow(row?.id)
      throw new Error(`CORRUPT_DEFERRED_REPLACEMENT_ROW:${error instanceof Error ? error.message : "unknown"}`)
    }
  }

  private isValidRoutingDecision(value: unknown): value is RouterDecision {
    if (!value || typeof value !== "object") return false
    const decision = value as Record<string, unknown>
    return ["FAST_DIRECT", "SPECIALIST", "PARALLEL_SPECIALISTS", "STANDARD", "DEEP"].includes(String(decision.executionClass))
      && typeof decision.reason === "string" && decision.reason.length > 0
      && typeof decision.reasonCode === "string" && decision.reasonCode.length > 0
      && typeof decision.confidence === "number" && Number.isFinite(decision.confidence)
      && decision.confidence >= 0 && decision.confidence <= 1
      && typeof decision.forcedByExplicitSignal === "boolean"
  }

  private quarantineCorruptActiveRow(id: unknown): void {
    if (typeof id !== "string" || id.length === 0) return
    this.db.query(`
      UPDATE deferred_replacements
      SET status = 'blocked', updated_at = ?
      WHERE id = ? AND status IN ('pending_termination', 'resuming', 'handoff_pending', 'handoff_outcome_unknown')
    `).run(new Date().toISOString(), id)
  }
}
