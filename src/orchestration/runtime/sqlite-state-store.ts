/**
 * SQLite-backed StateStore for FlowDeck orchestration runtime.
 *
 * Persists run states and transition events in a transactional manner.
 * `commitTransition` inserts state + event atomically inside a single
 * SQLite transaction, using optimistic locking (version check) to detect
 * concurrent modifications.
 *
 * Uses bun:sqlite's synchronous transaction API — all methods are synchronous
 * and safe to call inside a UnitOfWork callback.
 *
 * @module orchestration/runtime/sqlite-state-store
 */

import type { Database } from "bun:sqlite";
import type { State } from "./states.js";
import type {
  RunState,
  TransitionEvent,
  CommitTransitionParams,
  CommitTransitionResult,
  StateStore,
  VerificationResultData,
  EvidenceData,
  CompletionDecisionData,
  RecoveryAttemptData,
  ContextBudgetData,
  ContextBudgetRow,
  CancellationPhase,
  CancellationPhaseInfo,
  ContractRecord,
  CreateRunParams,
  CreateRunResult,
  LoadedRun,
  CircuitBreakerRow,
} from "./state-store.js";

/** Raw row shape of the `contracts` table. */
interface ContractDbRow {
  contract_id: string;
  hash: string;
  version: string;
  objective: string;
  requirements: string;
  acceptance_criteria: string;
  constraints: string;
  exclusions: string;
  required_evidence: string;
  required_verification: string;
  starting_sha: string;
  allowed_mutation_scope: string;
  approval_gates: string;
  created_at: string;
  activated_at: string | null;
  status: string;
}

function rowToContractRecord(r: ContractDbRow): ContractRecord {
  return {
    contractId: r.contract_id,
    hash: r.hash,
    version: r.version,
    objective: r.objective,
    requirements: r.requirements,
    acceptanceCriteria: r.acceptance_criteria,
    constraints: r.constraints,
    exclusions: r.exclusions,
    requiredEvidence: r.required_evidence,
    requiredVerification: r.required_verification,
    startingSha: r.starting_sha,
    allowedMutationScope: r.allowed_mutation_scope,
    approvalGates: r.approval_gates,
    createdAt: r.created_at,
    activatedAt: r.activated_at ?? undefined,
    status: r.status,
  };
}

/**
 * Table schemas for the runtime state store. All tables are scoped
 * to the runtime state machine and are independent of the production
 * persistence layer (task_runs, events, etc.).
 */
const SCHEMA_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS run_states (
    run_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
  )`,

  `CREATE TABLE IF NOT EXISTS transition_events (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    transition_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq),
    FOREIGN KEY (run_id) REFERENCES run_states(run_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS contracts (
    contract_id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL,
    objective TEXT NOT NULL,
    requirements TEXT NOT NULL DEFAULT '[]',
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    constraints TEXT NOT NULL DEFAULT '[]',
    exclusions TEXT NOT NULL DEFAULT '[]',
    required_evidence TEXT NOT NULL DEFAULT '[]',
    required_verification TEXT NOT NULL DEFAULT '[]',
    starting_sha TEXT NOT NULL,
    allowed_mutation_scope TEXT NOT NULL,
    approval_gates TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    activated_at TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
  )`,

  `CREATE TABLE IF NOT EXISTS run_contract_associations (
    run_id TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    associated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, contract_id),
    FOREIGN KEY (run_id) REFERENCES run_states(run_id) ON DELETE CASCADE,
    FOREIGN KEY (contract_id) REFERENCES contracts(contract_id) ON DELETE RESTRICT
  )`,

  `CREATE TABLE IF NOT EXISTS verification_results (
    run_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    status TEXT NOT NULL,
    target_sha TEXT NOT NULL,
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, check_id),
    FOREIGN KEY (run_id) REFERENCES run_states(run_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS evidence (
    evidence_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    sha TEXT NOT NULL,
    file_path TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES run_states(run_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS completion_decisions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    sha TEXT NOT NULL,
    checks TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    decided_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES run_states(run_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS recovery_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    previous_state TEXT NOT NULL,
    failure_reason TEXT NOT NULL,
    error_key TEXT NOT NULL,
    action TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    duration_ms INTEGER,
    FOREIGN KEY (run_id) REFERENCES run_states(run_id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS circuit_breakers (
    name TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_failure_at TEXT,
    last_state_change_at TEXT NOT NULL,
    total_successes INTEGER NOT NULL DEFAULT 0,
    total_failures INTEGER NOT NULL DEFAULT 0,
    half_open_successes INTEGER NOT NULL DEFAULT 0,
    half_open_attempts INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS context_budgets (
    run_id TEXT PRIMARY KEY,
    total_budget INTEGER NOT NULL,
    mandatory_cost INTEGER NOT NULL DEFAULT 0,
    high_value_cost INTEGER NOT NULL DEFAULT 0,
    optional_cost INTEGER NOT NULL DEFAULT 0,
    remaining_budget INTEGER NOT NULL,
    is_over_budget INTEGER NOT NULL DEFAULT 0,
    truncation_needed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES run_states(run_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_te_run_seq ON transition_events(run_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_rca_run ON run_contract_associations(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_vr_run ON verification_results(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cd_run ON completion_decisions(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ra_run ON recovery_attempts(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cb_state ON circuit_breakers(state)`,
];

/** Error thrown when optimistic locking detects a version conflict. */
export class VersionConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Version conflict for run ${runId}: expected ${expectedVersion}, got ${actualVersion}`,
    );
    this.name = "VersionConflictError";
  }
}

/** Internal hook for fault injection — set by enableFaultInjection. */
let faultHook: ((point: string) => void) | null = null;

/**
 * Enable fault injection for testing rollback behavior.
 *
 * When enabled, the given hook is invoked at strategic points during
 * commitTransition. A test can throw from the hook to simulate a failure
 * mid-transaction, verifying that the SQLite transaction rolls back.
 *
 * @param hook Called with a label like "after_state_insert" or "after_event_insert".
 */
export function enableFaultInjection(hook: (point: string) => void): void {
  faultHook = hook;
}

/** Disable fault injection. */
export function disableFaultInjection(): void {
  faultHook = null;
}

/**
 * Check if the run_states table exists (schema init state).
 */
export function hasRuntimeSchema(db: Database): boolean {
  const r = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='run_states'",
    )
    .get() as { name: string } | undefined;
  return !!r;
}

/**
 * Initialize the runtime state store schema in the given database.
 * Safe to call multiple times — uses CREATE TABLE IF NOT EXISTS.
 */
export function initRuntimeSchema(db: Database): void {
  for (const sql of SCHEMA_SQL) {
    db.exec(sql);
  }
}

/** Current schema version for the runtime state store. */
export const RUNTIME_SCHEMA_VERSION = 2;

/** Read the current PRAGMA user_version. */
export function getSchemaVersion(db: Database): number {
  const r = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  return r.user_version;
}

/**
 * Migrate a database to the current runtime schema version.
 *
 * v1: original schema (transition_events.seq was `INTEGER GENERATED ALWAYS
 *     AS IDENTITY`, which is invalid SQLite syntax and could not create the
 *     table).
 * v2: transition_events.seq is a plain INTEGER, sequenced per-run in
 *     application code inside the same transaction.
 *
 * The migration drops a broken `transition_events` table if present and
 * recreates it with the corrected schema. Transition events are append-only
 * audit data and are safely rebuilt from future commits; a broken table
 * could not have accepted inserts anyway.
 */
export function migrateRuntimeSchema(db: Database): void {
  let version = getSchemaVersion(db);
  if (version >= RUNTIME_SCHEMA_VERSION) return;

  if (version < 1) {
    initRuntimeSchema(db);
    version = 1;
    db.exec("PRAGMA user_version = 1");
  }

  if (version < 2) {
    const hasEvents = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='transition_events'",
      )
      .get();
    if (hasEvents) {
      db.exec("DROP TABLE transition_events");
    }
    const eventsSql = SCHEMA_SQL.find((sql) =>
      sql.includes("transition_events"),
    );
    if (eventsSql) db.exec(eventsSql);
    db.exec("PRAGMA user_version = 2");
  }
}

/**
 * SQLite-backed implementation of StateStore.
 *
 * Uses bun:sqlite's synchronous transaction API for atomicity.
 * All methods are synchronous (wrap with Promise.resolve for async interface).
 */
export class SqliteStateStore implements StateStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    if (!hasRuntimeSchema(db)) {
      initRuntimeSchema(db);
    }
    migrateRuntimeSchema(db);
  }

  async loadState(runId: string): Promise<RunState | null> {
    const r = this.db
      .query(
        `SELECT run_id, state, version, last_updated FROM run_states WHERE run_id = ?`,
      )
      .get(runId) as { run_id: string; state: string; version: number; last_updated: string } | undefined;

    if (!r) return null;
    return {
      runId: r.run_id,
      state: r.state as State,
      version: r.version,
      lastUpdated: new Date(r.last_updated),
    };
  }

  async commitTransition(
    params: CommitTransitionParams,
  ): Promise<CommitTransitionResult> {
    try {
      return this.db.transaction(() => {
        // 1. Read current state with optimistic lock check
        const current = this.db
          .query(
            `SELECT version, metadata FROM run_states WHERE run_id = ?`,
          )
          .get(params.runId) as { version: number; metadata: string } | undefined;

        if (!current) {
          return { committed: false, reason: "run_not_found" as const };
        }

        if (current.version !== params.expectedVersion) {
          return { committed: false, reason: "version_conflict" as const };
        }

        const newVersion = current.version + 1;
        const now = new Date().toISOString();

        const metadataJson =
          params.metadata !== undefined
            ? JSON.stringify(params.metadata)
            : (current.metadata ?? "{}");

        // 2. Update state row (version bump is the CAS)
        this.db
          .query(
            `UPDATE run_states
             SET state = ?, version = ?, last_updated = ?, metadata = ?
             WHERE run_id = ? AND version = ?`,
          )
          .run(
            params.state,
            newVersion,
            now,
            metadataJson,
            params.runId,
            params.expectedVersion,
          );

        // Fault injection point: after state update, before event insert
        faultHook?.("after_state_update");

        // Verify the update actually happened (CAS via SQL)
        const updateResult = this.db
          .query(
            `SELECT changes() as changed`,
          )
          .get() as { changed: number };
        if (updateResult.changed === 0) {
          return { committed: false, reason: "version_conflict" as const };
        }

        // 3. Insert the transition event atomically.
        //    seq is computed per-run inside the same transaction.
        const nextSeq = this.db
          .query(
            `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
             FROM transition_events WHERE run_id = ?`,
          )
          .get(params.runId) as { next_seq: number };
        this.db
          .query(
            `INSERT INTO transition_events
             (run_id, seq, from_state, to_state, transition_type, timestamp)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            params.runId,
            nextSeq.next_seq,
            params.event.from,
            params.event.to,
            params.event.transitionType,
            params.event.timestamp,
          );

        // Fault injection point: after event insert, before commit
        faultHook?.("after_event_insert");

        return { committed: true, newVersion };
      })();
    } catch {
      // SQLite transaction auto-rolls back on throw
      return { committed: false, reason: "error" };
    }
  }

  // ── Deprecated methods (delegate to commitTransition pattern) ──────────

  /**
   * Insert the initial run state row, or CAS-update an existing row.
   *
   * The orchestrator's `createTask` uses this as the initial insert, so a
   * missing row must be inserted (version 0) rather than rejected. Existing
   * rows still require the expected version to match (optimistic locking).
   *
   * @deprecated Use commitTransition for state changes; kept for createTask.
   */
  async saveState(
    runId: string,
    state: State,
    expectedVersion: number,
  ): Promise<boolean> {
    const current = this.db
      .query(
        `SELECT version FROM run_states WHERE run_id = ?`,
      )
      .get(runId) as { version: number } | undefined;

    if (!current) {
      // Initial insert — version must be 0 (no prior state exists).
      if (expectedVersion !== 0) return false;
      const result = this.db
        .query(
          `INSERT INTO run_states (run_id, state, version, last_updated, metadata)
           VALUES (?, ?, 0, datetime('now'), '{}')`,
        )
        .run(runId, state);
      return result.changes > 0;
    }

    if (current.version !== expectedVersion) return false;

    const newVersion = current.version + 1;
    const result = this.db
      .query(
        `UPDATE run_states
         SET state = ?, version = ?, last_updated = datetime('now')
         WHERE run_id = ? AND version = ?`,
      )
      .run(state, newVersion, runId, expectedVersion);

    return result.changes > 0;
  }

  /** @deprecated Use commitTransition */
  async recordEvent(
    runId: string,
    event: TransitionEvent,
  ): Promise<void> {
    const nextSeq = this.db
      .query(
        `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
         FROM transition_events WHERE run_id = ?`,
      )
      .get(runId) as { next_seq: number };
    this.db
      .query(
        `INSERT INTO transition_events
         (run_id, seq, from_state, to_state, transition_type, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        nextSeq.next_seq,
        event.from,
        event.to,
        event.transitionType,
        event.timestamp,
      );
  }

  // ── Runtime convenience persistence methods ────────────────────────────

  async createRun(params: CreateRunParams): Promise<CreateRunResult> {
    try {
      return this.db.transaction(() => {
        const existing = this.db
          .query(`SELECT run_id FROM run_states WHERE run_id = ?`)
          .get(params.runId);
        if (existing) {
          return { committed: false, version: 0, reason: "run_exists" as const };
        }

        const now = new Date().toISOString();

        // 1. Contract
        this.db
          .query(
            `INSERT OR IGNORE INTO contracts (
               contract_id, hash, version, objective,
               requirements, acceptance_criteria, constraints, exclusions,
               required_evidence, required_verification, starting_sha,
               allowed_mutation_scope, approval_gates,
               created_at, activated_at, status
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            params.contract.contractId,
            params.contract.hash,
            params.contract.version,
            params.contract.objective,
            params.contract.requirements,
            params.contract.acceptanceCriteria,
            params.contract.constraints,
            params.contract.exclusions,
            params.contract.requiredEvidence,
            params.contract.requiredVerification,
            params.contract.startingSha,
            params.contract.allowedMutationScope,
            params.contract.approvalGates,
            params.contract.createdAt,
            params.contract.activatedAt ?? null,
            params.contract.status,
          );

        // 2. Run state row (version 0)
        this.db
          .query(
            `INSERT INTO run_states (run_id, state, version, last_updated, metadata)
             VALUES (?, ?, 0, ?, '{}')`,
          )
          .run(params.runId, params.initialState, now);

        // 3. Run-to-contract association (after run_states exists for FK)
        this.db
          .query(
            `INSERT OR IGNORE INTO run_contract_associations
             (run_id, contract_id, associated_at) VALUES (?, ?, ?)`,
          )
          .run(params.runId, params.contract.contractId, now);

        // 3. Creation event (seq 0)
        if (params.creationEvent) {
          this.db
            .query(
              `INSERT INTO transition_events
               (run_id, seq, from_state, to_state, transition_type, timestamp)
               VALUES (?, 0, ?, ?, ?, ?)`,
            )
            .run(
              params.runId,
              params.creationEvent.from,
              params.creationEvent.to,
              params.creationEvent.transitionType,
              params.creationEvent.timestamp,
            );
        }

        // 4. Context budget (if provided)
        if (params.budget) {
          this.db
            .query(
              `INSERT OR IGNORE INTO context_budgets (
                 run_id, total_budget, mandatory_cost, high_value_cost,
                 optional_cost, remaining_budget, is_over_budget,
                 truncation_needed, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              params.runId,
              params.budget.totalBudget,
              params.budget.mandatoryCost,
              params.budget.highValueCost,
              params.budget.optionalCost,
              params.budget.remainingBudget,
              params.budget.isOverBudget ? 1 : 0,
              params.budget.truncationNeeded,
              now,
            );
        }

        return { committed: true, version: 0 };
      })();
    } catch {
      return { committed: false, version: 0, reason: "error" };
    }
  }

  async saveContract(contract: ContractRecord): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO contracts (
           contract_id, hash, version, objective,
           requirements, acceptance_criteria, constraints, exclusions,
           required_evidence, required_verification, starting_sha,
           allowed_mutation_scope, approval_gates,
           created_at, activated_at, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        contract.contractId,
        contract.hash,
        contract.version,
        contract.objective,
        contract.requirements,
        contract.acceptanceCriteria,
        contract.constraints,
        contract.exclusions,
        contract.requiredEvidence,
        contract.requiredVerification,
        contract.startingSha,
        contract.allowedMutationScope,
        contract.approvalGates,
        contract.createdAt,
        contract.activatedAt ?? null,
        contract.status,
      );
  }

  async loadContract(contractId: string): Promise<ContractRecord | null> {
    const r = this.db
      .query(`SELECT * FROM contracts WHERE contract_id = ?`)
      .get(contractId) as ContractDbRow | undefined;
    return r ? rowToContractRecord(r) : null;
  }

  async loadContractForRun(runId: string): Promise<ContractRecord | null> {
    const r = this.db
      .query(
        `SELECT c.* FROM contracts c
         JOIN run_contract_associations rca ON rca.contract_id = c.contract_id
         WHERE rca.run_id = ?`,
      )
      .get(runId) as ContractDbRow | undefined;
    return r ? rowToContractRecord(r) : null;
  }

  async loadEvents(runId: string): Promise<readonly TransitionEvent[]> {
    const rows = this.db
      .query(
        `SELECT run_id, from_state, to_state, transition_type, timestamp
         FROM transition_events WHERE run_id = ? ORDER BY seq ASC`,
      )
      .all(runId) as {
      run_id: string;
      from_state: string;
      to_state: string;
      transition_type: string;
      timestamp: number;
    }[];
    return rows.map((r) => ({
      runId: r.run_id,
      from: r.from_state as State,
      to: r.to_state as State,
      transitionType: r.transition_type as TransitionEvent["transitionType"],
      timestamp: r.timestamp,
    }));
  }

  async loadRecoveryAttempts(runId: string): Promise<readonly RecoveryAttemptData[]> {
    const rows = this.db
      .query(
        `SELECT id, run_id, attempt_number, previous_state, failure_reason,
                error_key, action
         FROM recovery_attempts WHERE run_id = ? ORDER BY attempt_number ASC`,
      )
      .all(runId) as {
      id: string;
      run_id: string;
      attempt_number: number;
      previous_state: string;
      failure_reason: string;
      error_key: string;
      action: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      attemptNumber: r.attempt_number,
      previousState: r.previous_state as State,
      failureReason: r.failure_reason,
      errorKey: r.error_key,
      action: r.action,
    }));
  }

  async loadCircuitBreaker(name: string): Promise<CircuitBreakerRow | null> {
    const r = this.db
      .query(`SELECT * FROM circuit_breakers WHERE name = ?`)
      .get(name) as CircuitBreakerRow | undefined;
    return r ?? null;
  }

  async loadVerificationResults(runId: string): Promise<readonly VerificationResultData[]> {
    const rows = this.db
      .query(
        `SELECT run_id, check_id, rule_id, status, target_sha, evidence_ids
         FROM verification_results WHERE run_id = ?`,
      )
      .all(runId) as {
      run_id: string;
      check_id: string;
      rule_id: string;
      status: string;
      target_sha: string;
      evidence_ids: string;
    }[];
    return rows.map((r) => ({
      checkId: r.check_id,
      ruleId: r.rule_id,
      status: r.status,
      targetSha: r.target_sha,
      evidenceIds: JSON.parse(r.evidence_ids) as string[],
    }));
  }

  async loadEvidence(runId: string): Promise<readonly EvidenceData[]> {
    const rows = this.db
      .query(
        `SELECT evidence_id, run_id, evidence_type, content_hash, sha, file_path
         FROM evidence WHERE run_id = ?`,
      )
      .all(runId) as {
      evidence_id: string;
      run_id: string;
      evidence_type: string;
      content_hash: string;
      sha: string;
      file_path: string | null;
    }[];
    return rows.map((r) => ({
      id: r.evidence_id,
      runId: r.run_id,
      type: r.evidence_type,
      contentHash: r.content_hash,
      sha: r.sha,
      filePath: r.file_path ?? undefined,
    }));
  }

  async loadCompletionDecision(runId: string): Promise<CompletionDecisionData | null> {
    const r = this.db
      .query(
        `SELECT id, run_id, decision, sha, checks, idempotency_key
         FROM completion_decisions WHERE run_id = ?`,
      )
      .get(runId) as {
      id: string;
      run_id: string;
      decision: string;
      sha: string;
      checks: string;
      idempotency_key: string;
    } | undefined;
    if (!r) return null;
    return {
      id: r.id,
      runId: r.run_id,
      decision: r.decision,
      sha: r.sha,
      checks: r.checks,
      idempotencyKey: r.idempotency_key,
    };
  }

  async loadRun(runId: string): Promise<LoadedRun | null> {
    const state = await this.loadState(runId);
    const contract = await this.loadContractForRun(runId);
    if (!state && !contract) return null;

    const circuitBreakerRows = this.db
      .query(`SELECT * FROM circuit_breakers`)
      .all() as CircuitBreakerRow[];

    return {
      runId,
      state,
      contract,
      events: await this.loadEvents(runId),
      recoveryAttempts: await this.loadRecoveryAttempts(runId),
      circuitBreakers: circuitBreakerRows,
      cancellationPhase: await this.loadCancellationPhase(runId),
      budget: await this.loadContextBudget(runId),
      verificationResults: await this.loadVerificationResults(runId),
      evidence: await this.loadEvidence(runId),
      completionDecision: await this.loadCompletionDecision(runId),
    };
  }

  async initializeRun(runId: string, state: State): Promise<void> {
    this.db
      .query(
        `INSERT OR IGNORE INTO run_states
         (run_id, state, version, last_updated, metadata)
         VALUES (?, ?, 0, ?, '{}')`,
      )
      .run(runId, state, new Date().toISOString());
  }

  async associateContract(runId: string, contractId: string): Promise<void> {
    this.db
      .query(
        `INSERT OR IGNORE INTO run_contract_associations
         (run_id, contract_id, associated_at)
         VALUES (?, ?, datetime('now'))`,
      )
      .run(runId, contractId);
  }

  async saveVerificationResult(
    runId: string,
    result: VerificationResultData,
  ): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO verification_results
         (run_id, check_id, rule_id, status, target_sha, evidence_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        runId,
        result.checkId,
        result.ruleId,
        result.status,
        result.targetSha,
        JSON.stringify([...result.evidenceIds]),
      );
  }

  async saveEvidence(evidence: EvidenceData): Promise<void> {
    this.db
      .query(
        `INSERT OR IGNORE INTO evidence
         (evidence_id, run_id, evidence_type, content_hash, sha, file_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        evidence.id,
        evidence.runId,
        evidence.type,
        evidence.contentHash,
        evidence.sha,
        evidence.filePath ?? null,
      );
  }

  async saveCompletionDecision(
    decision: CompletionDecisionData,
  ): Promise<void> {
    this.db
      .query(
        `INSERT OR IGNORE INTO completion_decisions
         (id, run_id, decision, sha, checks, idempotency_key, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.runId,
        decision.decision,
        decision.sha,
        decision.checks,
        decision.idempotencyKey,
        new Date().toISOString(),
      );
  }

  async recordRecoveryAttempt(
    attempt: RecoveryAttemptData,
  ): Promise<void> {
    this.db
      .query(
        `INSERT INTO recovery_attempts
         (id, run_id, attempt_number, previous_state, failure_reason, error_key, action, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        attempt.id,
        attempt.runId,
        attempt.attemptNumber,
        attempt.previousState,
        attempt.failureReason,
        attempt.errorKey,
        attempt.action,
      );
  }

  async saveCircuitBreaker(
    name: string,
    state: {
      state: string;
      failureCount: number;
      lastFailureAt?: Date;
      lastStateChangeAt: Date;
      totalSuccesses: number;
      totalFailures: number;
      halfOpenSuccesses: number;
      halfOpenAttempts: number;
    },
  ): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO circuit_breakers
         (name, state, failure_count, last_failure_at, last_state_change_at,
          total_successes, total_failures, half_open_successes, half_open_attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        state.state,
        state.failureCount,
        state.lastFailureAt?.toISOString() ?? null,
        state.lastStateChangeAt.toISOString(),
        state.totalSuccesses,
        state.totalFailures,
        state.halfOpenSuccesses,
        state.halfOpenAttempts,
      );
  }

  async saveContextBudget(runId: string, budget: ContextBudgetData): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO context_budgets
         (run_id, total_budget, mandatory_cost, high_value_cost, optional_cost,
          remaining_budget, is_over_budget, truncation_needed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        runId,
        budget.totalBudget,
        budget.mandatoryCost,
        budget.highValueCost,
        budget.optionalCost,
        budget.remainingBudget,
        budget.isOverBudget ? 1 : 0,
        budget.truncationNeeded,
      );
  }

  async loadContextBudget(runId: string): Promise<ContextBudgetRow | null> {
    const r = this.db
      .query(
        `SELECT * FROM context_budgets WHERE run_id = ?`,
      )
      .get(runId) as ContextBudgetRow | undefined;
    return r ?? null;
  }

  async saveCancellationPhase(
    runId: string,
    phase: CancellationPhase,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const jsonStr = JSON.stringify(details ?? {});
    this.db
      .query(
        `UPDATE run_states
         SET metadata = json_set(metadata, '$.cancellationPhase', ?, '$.cancellationDetails', json(?))
         WHERE run_id = ?`,
      )
      .run(phase, jsonStr, runId);
  }

  async loadCancellationPhase(runId: string): Promise<CancellationPhaseInfo | null> {
    const r = this.db
      .query(
        `SELECT metadata FROM run_states WHERE run_id = ?`,
      )
      .get(runId) as { metadata: string } | undefined;

    if (!r) return null;
    try {
      const parsed = JSON.parse(r.metadata) as Record<string, unknown>;
      const phase = parsed.cancellationPhase as string | undefined;
      if (!phase) return null;
      let details = parsed.cancellationDetails;
      if (typeof details === "string") {
        try {
          details = JSON.parse(details);
        } catch {
          // ignore
        }
      }
      return {
        phase: phase as CancellationPhase,
        details: (details as Record<string, unknown>) ?? undefined,
      };
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * Create a fresh in-memory SQLite StateStore for testing.
 * Initializes the full runtime schema.
 */
export function createInMemoryStateStore(): SqliteStateStore {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite") as {
    Database: typeof import("bun:sqlite").Database;
  };
  const db = new Database(":memory:");
  initRuntimeSchema(db);
  return new SqliteStateStore(db);
}

/**
 * Open a production on-disk SQLite StateStore.
 *
 * Fails hard (throws) if the database cannot be opened, created, or
 * migrated. There is intentionally NO fallback to an in-memory store —
 * production persistence must never silently degrade.
 *
 * @param dbPath Path to the SQLite database file.
 * @throws If the database file cannot be opened or the schema migration fails.
 */
export function openSqliteStateStore(dbPath: string): SqliteStateStore {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite") as {
    Database: typeof import("bun:sqlite").Database;
  };
  if (!dbPath || dbPath.trim() === "") {
    throw new Error(
      "Runtime persistence: dbPath is required for production runtime",
    );
  }
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  try {
    migrateRuntimeSchema(db);
  } catch (err) {
    db.close();
    throw new Error(
      `Runtime persistence: failed to initialize database at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return new SqliteStateStore(db);
}
