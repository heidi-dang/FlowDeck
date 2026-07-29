/** SQLite adapters for runtime domain ports. No policy logic. */
import type Database from "better-sqlite3"
import type { TransactionManager } from "../transaction-manager"
import { ConcurrencyError } from "../errors"
import type { TaskRunRecord, RunRequirementRecord, RunAcceptanceCriterionRecord, EventRecord, OutboxRecord } from "../../domain/ports/runtime-repository"

export class SqliteTaskRunAdapter {
  constructor(private db: Database.Database, private tx: TransactionManager) {}

  async insertRun(r: TaskRunRecord): Promise<TaskRunRecord> {
    return this.tx.write(() => {
      this.db.prepare(`INSERT INTO task_runs (run_id,contract_id,strategy,state,aggregate_version,baseline_sha,repo_branch,created_at,created_ts) VALUES (?,?,?,?,?,?,?,datetime('now'),strftime('%s','now'))`).run(r.runId,r.contractId,r.strategy,r.state,1,r.baselineSha,r.repoBranch)
      return this.getRun(r.runId) as Promise<TaskRunRecord>
    }) as any
  }

  async getRun(id: string): Promise<TaskRunRecord | null> {
    const r = this.db.prepare("SELECT * FROM task_runs WHERE run_id=?").get(id) as any
    if (!r) return null
    return { runId: r.run_id, contractId: r.contract_id, strategy: r.strategy, state: r.state, aggregateVersion: r.aggregate_version, baselineSha: r.baseline_sha, currentSha: r.current_sha, verificationSha: r.verification_sha, completionSha: r.completion_sha, repoBranch: r.repo_branch, workingTreeClean: !!r.working_tree_clean, previousRunId: r.previous_run_id, createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at }
  }

  async updateState(runId: string, state: string, expectedVersion: number): Promise<void> {
    this.tx.write(() => {
      const r = this.db.prepare("UPDATE task_runs SET state=?,aggregate_version=aggregate_version+1 WHERE run_id=? AND aggregate_version=?").run(state, runId, expectedVersion)
      if (r.changes === 0) throw new ConcurrencyError(1, `task_run ${runId} version mismatch: expected ${expectedVersion}`)
    })
  }

  async insertRunRequirement(r: RunRequirementRecord): Promise<RunRequirementRecord> {
    return this.tx.write(() => { this.db.prepare("INSERT INTO run_requirements (id,run_id,requirement_id,status,started_at,completed_at) VALUES (?,?,?,?,?,?)").run(r.id,r.runId,r.requirementId,r.status,r.startedAt,r.completedAt); return r })
  }

  async insertRunCriterion(r: RunAcceptanceCriterionRecord): Promise<RunAcceptanceCriterionRecord> {
    return this.tx.write(() => { this.db.prepare("INSERT INTO run_acceptance_criteria (id,run_id,criterion_id,status,verified_at,verified_by,failure_reason) VALUES (?,?,?,?,?,?,?)").run(r.id,r.runId,r.criterionId,r.status,r.verifiedAt,r.verifiedBy,r.failureReason); return r })
  }

  async appendEventWithOutbox(event: EventRecord, outbox: OutboxRecord): Promise<{ event: EventRecord; outbox: OutboxRecord }> {
    return this.tx.write(() => {
      // 1. Verify expected aggregate version
      const current = (this.db.prepare("SELECT COALESCE(MAX(aggregate_version),0) AS v FROM events WHERE aggregate_type=? AND aggregate_id=?").get(event.aggregateType, event.aggregateId) as any).v
      if (event.aggregateVersion !== current + 1) throw new ConcurrencyError(1, `Event aggregate version: expected ${current + 1}, got ${event.aggregateVersion}`)
      // 2. Insert event
      this.db.prepare("INSERT INTO events (event_id,event_type,event_version,causation_id,correlation_id,aggregate_type,aggregate_id,aggregate_version,timestamp,data,metadata,created_ts) VALUES (?,?,1,?,?,?,?,?,datetime('now'),?,?,strftime('%s','now'))").run(event.eventId,event.eventType,event.causationId,event.correlationId,event.aggregateType,event.aggregateId,event.aggregateVersion,event.data,event.metadata)
      // 3. Insert outbox
      this.db.prepare("INSERT INTO event_outbox (id,event_id,event_type,aggregate_id,data,status,idempotency_key,source_component,created_ts) VALUES (?,?,?,?,?,'pending',?,?,strftime('%s','now'))").run(outbox.id,outbox.eventId,outbox.eventType,outbox.aggregateId,outbox.data,outbox.idempotencyKey,outbox.sourceComponent)
      return { event: this.db.prepare("SELECT * FROM events WHERE event_id=?").get(event.eventId) as any, outbox: this.db.prepare("SELECT * FROM event_outbox WHERE id=?").get(outbox.id) as any }
    }) as any
  }
}
