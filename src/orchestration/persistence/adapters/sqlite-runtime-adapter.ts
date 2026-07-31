/** SQLite adapters for runtime domain ports. No policy logic. */
import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../transaction-manager"
import { ConcurrencyError } from "../errors"
import type { TaskRunRecord, RunRequirementRecord, RunAcceptanceCriterionRecord, EventRecord, OutboxRecord } from "../../domain/ports/runtime-repository"

const VALID_STRATEGIES = new Set(['simple', 'planned', 'delegated', 'audit', 'recovery']);
const VALID_STATES = new Set(['created', 'planning', 'analysing', 'delegating', 'executing', 'verifying', 'recovering', 'completed', 'failed', 'cancelled']);

function mapState(s: string): string {
  if (VALID_STATES.has(s)) return s;
  if (s === "queued" || s === "pending") return "created";
  if (s === "running") return "executing";
  if (s === "paused") return "created";
  return "created";
}

export class SqliteTaskRunAdapter {
  constructor(private db: Database, private tx: TransactionManager) {}

  insertRunSync(r: TaskRunRecord): TaskRunRecord {
    const contractId = r.contractId ?? 'contract-default';
    this.db.query(`INSERT OR IGNORE INTO contract_families (family_id, name, description, created_by, created_at) VALUES ('family-default', 'Default Family', 'Default contract family', 'system', datetime('now'))`).run();
    this.db.query(`INSERT OR IGNORE INTO task_contracts (contract_id, family_id, version, title, description, repo_url, repo_sha, created_by, created_at) VALUES (?, 'family-default', 1, 'Default Contract', 'Default contract description', 'https://github.com/heidi-dang/FlowDeck', '0000000000000000000000000000000000000000', 'system', datetime('now'))`).run(contractId);

    const strategy = VALID_STRATEGIES.has(r.strategy) ? r.strategy : 'simple';
    const state = mapState(r.state);
    this.db.query(`INSERT INTO task_runs (run_id,contract_id,strategy,state,aggregate_version,baseline_sha,repo_branch,created_at,created_ts) VALUES (?,?,?,?,?,?,?,datetime('now'),strftime('%s','now'))`).run(r.runId,contractId,strategy,state,1,r.baselineSha ?? '0000000000000000000000000000000000000000',r.repoBranch ?? 'main')
    return this.getRunSync(r.runId)!
  }

  insertRun(r: TaskRunRecord): Promise<TaskRunRecord> {
    return Promise.resolve(this.tx.write(() => this.insertRunSync(r)))
  }

  getRunSync(id: string): any {
    const r = this.db.query("SELECT * FROM task_runs WHERE run_id=?").get(id) as any
    if (!r) return null
    return { id: r.run_id, runId: r.run_id, contractId: r.contract_id, strategy: r.strategy, status: r.state, state: r.state, aggregateVersion: r.aggregate_version, baselineSha: r.baseline_sha, currentSha: r.current_sha, verificationSha: r.verification_sha, completionSha: r.completion_sha, repoBranch: r.repo_branch, workingTreeClean: !!r.working_tree_clean, previousRunId: r.previous_run_id, createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at }
  }

  async getRun(id: string): Promise<TaskRunRecord | null> {
    return this.getRunSync(id)
  }

  updateStateSync(runId: string, state: string, expectedVersion: number): void {
    const dbState = mapState(state);
    const r = this.db.query("UPDATE task_runs SET state=?,aggregate_version=aggregate_version+1 WHERE run_id=? AND aggregate_version=?").run(dbState, runId, expectedVersion)
    if (r.changes === 0) throw new ConcurrencyError(1, `task_run ${runId} version mismatch: expected ${expectedVersion}`)
  }

  async updateState(runId: string, state: string, expectedVersion: number): Promise<void> {
    this.tx.write(() => this.updateStateSync(runId, state, expectedVersion))
  }

  insertRunRequirement(r: RunRequirementRecord): Promise<RunRequirementRecord> {
    return Promise.resolve(this.tx.write(() => { this.db.query("INSERT INTO run_requirements (id,run_id,requirement_id,status,started_at,completed_at) VALUES (?,?,?,?,?,?)").run(r.id,r.runId,r.requirementId,r.status,r.startedAt,r.completedAt); return r }))
  }

  insertRunCriterion(r: RunAcceptanceCriterionRecord): Promise<RunAcceptanceCriterionRecord> {
    return Promise.resolve(this.tx.write(() => { this.db.query("INSERT INTO run_acceptance_criteria (id,run_id,criterion_id,status,verified_at,verified_by,failure_reason) VALUES (?,?,?,?,?,?,?)").run(r.id,r.runId,r.criterionId,r.status,r.verifiedAt,r.verifiedBy,r.failureReason); return r }))
  }

  appendEventWithOutboxSync(event: EventRecord, outbox: OutboxRecord): { event: EventRecord; outbox: OutboxRecord } {
    // 1. Verify expected aggregate version
    const current = (this.db.query("SELECT COALESCE(MAX(aggregate_version),0) AS v FROM events WHERE aggregate_type=? AND aggregate_id=?").get(event.aggregateType, event.aggregateId) as any).v
    if (event.aggregateVersion !== current + 1) throw new ConcurrencyError(1, `Event aggregate version: expected ${current + 1}, got ${event.aggregateVersion}`)
    // 2. Insert event
    this.db.query("INSERT INTO events (event_id,event_type,event_version,causation_id,correlation_id,aggregate_type,aggregate_id,aggregate_version,timestamp,data,metadata,created_ts) VALUES (?,?,1,?,?,?,?,?,datetime('now'),?,?,strftime('%s','now'))").run(event.eventId,event.eventType,event.causationId,event.correlationId,event.aggregateType,event.aggregateId,event.aggregateVersion,event.data,event.metadata)
    // 3. Insert outbox
    this.db.query("INSERT INTO event_outbox (id,event_id,event_type,aggregate_id,data,status,idempotency_key,source_component,created_ts) VALUES (?,?,?,?,?,'pending',?,?,strftime('%s','now'))").run(outbox.id,outbox.eventId,outbox.eventType,outbox.aggregateId,outbox.data,outbox.idempotencyKey,outbox.sourceComponent)
    return { event: this.db.query("SELECT * FROM events WHERE event_id=?").get(event.eventId) as any, outbox: this.db.query("SELECT * FROM event_outbox WHERE id=?").get(outbox.id) as any }
  }

  appendEventWithOutbox(event: EventRecord, outbox: OutboxRecord): Promise<{ event: EventRecord; outbox: OutboxRecord }> {
    return Promise.resolve(this.tx.write(() => this.appendEventWithOutboxSync(event, outbox)))
  }
}
