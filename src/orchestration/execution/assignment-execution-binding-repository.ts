import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../persistence/transaction-manager"

export type AssignmentDispatchState = "pending" | "dispatched" | "succeeded" | "failed" | "cancelled"

export interface AssignmentExecutionBinding {
  assignmentId: string
  runId: string
  planId: string
  workstreamId: string
  correlationId: string
  dispatchState: AssignmentDispatchState
  attemptCount: number
  lastAttemptId: string | null
  lastAttemptAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AssignmentBindingRecord {
  assignmentId: string
  runId: string
  planId: string
  workstreamId: string
  correlationId: string
}

/**
 * Durable, idempotent link between a logical Assignment and the
 * ExecutionPlan Workstream it serves, plus bounded dispatch-attempt identity.
 *
 * This is general runtime infrastructure owned by the canonical assignment
 * dispatch layer — not command-specific bookkeeping. It exists so that a fresh
 * runtime can reconcile which Assignment belongs to which Workstream after a
 * crash, and so that a crash after the dispatch boundary (R9) can be resolved
 * with exactly-once logical Assignment semantics and bounded physical attempts.
 */
export class SqliteAssignmentExecutionBindingRepository {
  constructor(private readonly db: Database, private readonly tx: TransactionManager) {}

  /** Idempotent: returns the existing binding if one already exists for the
   *  (plan, workstream) pair. The UNIQUE(plan_id, workstream_id) constraint
   *  guarantees at most one logical Assignment per Workstream even when two
   *  recoverers race to bind it. */
  ensureBinding(record: AssignmentBindingRecord, now: string): AssignmentExecutionBinding {
    return this.tx.write(() => {
      const existing = this.db
        .query("SELECT * FROM assignment_execution_bindings WHERE plan_id = ? AND workstream_id = ?")
        .get(record.planId, record.workstreamId) as Record<string, unknown> | null
      if (existing) return this.map(existing)
      this.db
        .query(
          `INSERT INTO assignment_execution_bindings
            (assignment_id, run_id, plan_id, workstream_id, correlation_id, dispatch_state, attempt_count, last_attempt_id, last_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)`,
        )
        .run(record.assignmentId, record.runId, record.planId, record.workstreamId, record.correlationId, now, now)
      return this.map(
        this.db.query("SELECT * FROM assignment_execution_bindings WHERE assignment_id = ?").get(record.assignmentId) as Record<string, unknown>,
      )
    })
  }

  getByAssignmentId(assignmentId: string): AssignmentExecutionBinding | null {
    const row = this.db.query("SELECT * FROM assignment_execution_bindings WHERE assignment_id = ?").get(assignmentId) as Record<string, unknown> | null
    return row ? this.map(row) : null
  }

  getByPlanAndWorkstream(planId: string, workstreamId: string): AssignmentExecutionBinding | null {
    const row = this.db
      .query("SELECT * FROM assignment_execution_bindings WHERE plan_id = ? AND workstream_id = ?")
      .get(planId, workstreamId) as Record<string, unknown> | null
    return row ? this.map(row) : null
  }

  listByPlan(planId: string): AssignmentExecutionBinding[] {
    return (this.db.query("SELECT * FROM assignment_execution_bindings WHERE plan_id = ? ORDER BY workstream_id").all(planId) as Record<string, unknown>[]).map(r => this.map(r))
  }

  listByRun(runId: string): AssignmentExecutionBinding[] {
    return (this.db.query("SELECT * FROM assignment_execution_bindings WHERE run_id = ? ORDER BY workstream_id").all(runId) as Record<string, unknown>[]).map(r => this.map(r))
  }

  /** Record a durable dispatch attempt. Increments the bounded attempt counter
   *  and stores the physical attempt id so recovery can resolve R9 ambiguity. */
  recordAttempt(assignmentId: string, attemptId: string, now: string): AssignmentExecutionBinding {
    return this.tx.write(() => {
      this.db
        .query(
          `UPDATE assignment_execution_bindings
             SET dispatch_state = 'dispatched', attempt_count = attempt_count + 1, last_attempt_id = ?, last_attempt_at = ?, updated_at = ?
           WHERE assignment_id = ?`,
        )
        .run(attemptId, now, now, assignmentId)
      return this.map(this.db.query("SELECT * FROM assignment_execution_bindings WHERE assignment_id = ?").get(assignmentId) as Record<string, unknown>)
    })
  }

  transition(assignmentId: string, state: AssignmentDispatchState, now: string): AssignmentExecutionBinding {
    return this.tx.write(() => {
      this.db
        .query("UPDATE assignment_execution_bindings SET dispatch_state = ?, updated_at = ? WHERE assignment_id = ?")
        .run(state, now, assignmentId)
      return this.map(this.db.query("SELECT * FROM assignment_execution_bindings WHERE assignment_id = ?").get(assignmentId) as Record<string, unknown>)
    })
  }

  private map(row: Record<string, unknown>): AssignmentExecutionBinding {
    return {
      assignmentId: String(row.assignment_id),
      runId: String(row.run_id),
      planId: String(row.plan_id),
      workstreamId: String(row.workstream_id),
      correlationId: String(row.correlation_id),
      dispatchState: String(row.dispatch_state) as AssignmentDispatchState,
      attemptCount: Number(row.attempt_count),
      lastAttemptId: row.last_attempt_id ? String(row.last_attempt_id) : null,
      lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}
