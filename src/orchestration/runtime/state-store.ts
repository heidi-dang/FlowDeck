/**
 * State persistence interfaces for FlowDeck orchestration runtime.
 * @module orchestration/runtime/state-store
 */

import type { State, TransitionType } from "./states.js";
export type { State, TransitionType };

export interface RunState {
  readonly runId: string;
  readonly state: State;
  readonly version: number;
  readonly lastUpdated: Date;
}

export interface TransitionEvent {
  readonly runId: string;
  readonly from: State;
  readonly to: State;
  readonly transitionType: TransitionType;
  readonly timestamp: number;
}

/**
 * Parameters for an atomic state+event commit.
 * The run state row is updated with optimistic locking on `expectedVersion`.
 * The transition event is inserted in the same transaction.
 */
export interface CommitTransitionParams {
  readonly runId: string;
  readonly state: State;
  readonly expectedVersion: number;
  readonly event: TransitionEvent;
  /** Optional metadata to persist alongside the state row. */
  readonly metadata?: Record<string, unknown>;
}

export interface CommitTransitionResult {
  readonly committed: boolean;
  /** New version after commit (present when committed). */
  readonly newVersion?: number;
  /** Present when optimistic lock check failed. */
  readonly reason?: "version_conflict" | "run_not_found" | "error";
}

export interface VerificationResultData {
  readonly checkId: string;
  readonly ruleId: string;
  readonly status: string;
  readonly targetSha: string;
  readonly evidenceIds: readonly string[];
}

export interface EvidenceData {
  readonly id: string;
  readonly runId: string;
  readonly type: string;
  readonly contentHash: string;
  readonly sha: string;
  readonly filePath?: string;
}

export interface CompletionDecisionData {
  readonly id: string;
  readonly runId: string;
  readonly decision: string;
  readonly sha: string;
  readonly checks: string;
  readonly idempotencyKey: string;
}

export interface RecoveryAttemptData {
  readonly id: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly previousState: State;
  readonly failureReason: string;
  readonly errorKey: string;
  readonly action: string;
}

export interface ContextBudgetData {
  readonly totalBudget: number;
  readonly mandatoryCost: number;
  readonly highValueCost: number;
  readonly optionalCost: number;
  readonly remainingBudget: number;
  readonly isOverBudget: boolean;
  readonly truncationNeeded: number;
}

export interface ContextBudgetRow {
  readonly run_id: string;
  readonly total_budget: number;
  readonly mandatory_cost: number;
  readonly high_value_cost: number;
  readonly optional_cost: number;
  readonly remaining_budget: number;
  readonly is_over_budget: number;
  readonly truncation_needed: number;
  readonly updated_at: string;
}

/** Row shape of the circuit_breakers table. */
export interface CircuitBreakerRow {
  readonly name: string;
  readonly state: string;
  readonly failure_count: number;
  readonly last_failure_at: string | null;
  readonly last_state_change_at: string;
  readonly total_successes: number;
  readonly total_failures: number;
  readonly half_open_successes: number;
  readonly half_open_attempts: number;
}

/**
 * Serialized contract record matching the `contracts` table.
 * Nested structures are stored as JSON strings.
 */
export interface ContractRecord {
  readonly contractId: string;
  readonly hash: string;
  readonly version: string;
  readonly objective: string;
  readonly requirements: string;
  readonly acceptanceCriteria: string;
  readonly constraints: string;
  readonly exclusions: string;
  readonly requiredEvidence: string;
  readonly requiredVerification: string;
  readonly startingSha: string;
  readonly allowedMutationScope: string;
  readonly approvalGates: string;
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly status: string;
}

/** Parameters for atomically creating a run (state + contract + event + budget). */
export interface CreateRunParams {
  readonly runId: string;
  readonly initialState: State;
  readonly contract: ContractRecord;
  readonly creationEvent?: TransitionEvent;
  readonly budget?: ContextBudgetData;
}

export interface CreateRunResult {
  readonly committed: boolean;
  readonly version: number;
  readonly reason?: "run_exists" | "error";
}

/** Full reconstruction of a run's durable state (restart safety). */
export interface LoadedRun {
  readonly runId: string;
  readonly state: RunState | null;
  readonly contract: ContractRecord | null;
  readonly events: readonly TransitionEvent[];
  readonly recoveryAttempts: readonly RecoveryAttemptData[];
  readonly circuitBreakers: readonly CircuitBreakerRow[];
  readonly cancellationPhase: CancellationPhaseInfo | null;
  readonly budget: ContextBudgetRow | null;
  readonly verificationResults: readonly VerificationResultData[];
  readonly evidence: readonly EvidenceData[];
  readonly completionDecision: CompletionDecisionData | null;
}

export type CancellationPhase =
  | "active"
  | "graceful_requested"
  | "force_requested"
  | "completed";

export interface CancellationPhaseInfo {
  readonly phase: CancellationPhase;
  readonly details?: Record<string, unknown>;
}

export interface StateStore {
  loadState(runId: string): Promise<RunState | null>;

  /**
   * Atomically commit a state transition + event in a single transaction.
   * Uses optimistic locking (version check) inside the transaction.
   *
   * @returns committed=false with reason="version_conflict" if expectedVersion
   *          does not match the current version.
   */
  commitTransition(params: CommitTransitionParams): Promise<CommitTransitionResult>;

  /**
   * @deprecated Use commitTransition for atomic state+event persistence.
   * saveState and recordEvent are not atomic together and cannot guarantee
   * the state+event invariant.
   */
  saveState(
    runId: string,
    state: State,
    expectedVersion: number,
  ): Promise<boolean>;

  /**
   * @deprecated Use commitTransition for atomic state+event persistence.
   */
  recordEvent(runId: string, event: TransitionEvent): Promise<void>;

  // ── Runtime convenience persistence methods ──────────────────────────────

  /**
   * Atomically create a run: inserts the run state row, contract,
   * run↔contract association, creation event, and context budget in a
   * single transaction. All-or-nothing — no partial writes.
   */
  createRun(params: CreateRunParams): Promise<CreateRunResult>;

  /**
   * Persist a contract. Survives restart.
   */
  saveContract(contract: ContractRecord): Promise<void>;

  /**
   * Load a contract by ID. Returns null if not found.
   */
  loadContract(contractId: string): Promise<ContractRecord | null>;

  /**
   * Load the contract associated with a run (via run_contract_associations).
   */
  loadContractForRun(runId: string): Promise<ContractRecord | null>;

  /**
   * Load all transition events for a run, ordered by sequence.
   */
  loadEvents(runId: string): Promise<readonly TransitionEvent[]>;

  /**
   * Load all persisted recovery attempts for a run.
   */
  loadRecoveryAttempts(runId: string): Promise<readonly RecoveryAttemptData[]>;

  /**
   * Load a persisted circuit breaker by name. Returns null if never saved.
   */
  loadCircuitBreaker(name: string): Promise<CircuitBreakerRow | null>;

  /**
   * Load verification results persisted for a run.
   */
  loadVerificationResults(runId: string): Promise<readonly VerificationResultData[]>;

  /**
   * Load evidence persisted for a run.
   */
  loadEvidence(runId: string): Promise<readonly EvidenceData[]>;

  /**
   * Load the persisted completion decision for a run.
   */
  loadCompletionDecision(runId: string): Promise<CompletionDecisionData | null>;

  /**
   * Fully reconstruct a run's durable state (state, contract, events,
   * recovery attempts, circuit breakers, cancellation phase, budget,
   * verification results, evidence, completion decision). Returns null
   * if the run does not exist.
   */
  loadRun(runId: string): Promise<LoadedRun | null>;

  initializeRun(runId: string, state: State): Promise<void>;

  associateContract(runId: string, contractId: string): Promise<void>;

  saveVerificationResult(runId: string, result: VerificationResultData): Promise<void>;

  saveEvidence(evidence: EvidenceData): Promise<void>;

  saveCompletionDecision(decision: CompletionDecisionData): Promise<void>;

  recordRecoveryAttempt(attempt: RecoveryAttemptData): Promise<void>;

  saveCircuitBreaker(
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
  ): Promise<void>;

  saveContextBudget(runId: string, budget: ContextBudgetData): Promise<void>;
  loadContextBudget(runId: string): Promise<ContextBudgetRow | null>;

  saveCancellationPhase(
    runId: string,
    phase: CancellationPhase,
    details?: Record<string, unknown>,
  ): Promise<void>;
  loadCancellationPhase(runId: string): Promise<CancellationPhaseInfo | null>;

  close?(): Promise<void>;
}

/**
 * Simple in-memory implementation of StateStore for testing and development.
 * Uses per-run optimistic concurrency via version numbers.
 */
export class InMemoryStateStore implements StateStore {
  private readonly states: Map<string, RunState> = new Map();
  private readonly events: Map<string, TransitionEvent[]> = new Map();
  private readonly budgets: Map<string, ContextBudgetData> = new Map();
  private readonly phases: Map<string, CancellationPhaseInfo> = new Map();
  private readonly contracts: Map<string, ContractRecord> = new Map();
  private readonly runContractLinks: Map<string, string> = new Map();
  private readonly verificationResults: Map<string, VerificationResultData[]> = new Map();
  private readonly evidenceItems: Map<string, EvidenceData[]> = new Map();
  private readonly completionDecisions: Map<string, CompletionDecisionData> = new Map();
  private readonly recoveryAttempts: Map<string, RecoveryAttemptData[]> = new Map();
  private readonly circuitBreakers: Map<string, CircuitBreakerRow> = new Map();

  async loadState(runId: string): Promise<RunState | null> {
    return this.states.get(runId) ?? null;
  }

  async commitTransition(
    params: CommitTransitionParams,
  ): Promise<CommitTransitionResult> {
    const current = this.states.get(params.runId);
    if (!current) {
      return { committed: false, reason: "run_not_found" };
    }
    if (current.version !== params.expectedVersion) {
      return { committed: false, reason: "version_conflict" };
    }
    const newVersion = current.version + 1;
    const newState: RunState = {
      runId: params.runId,
      state: params.state,
      version: newVersion,
      lastUpdated: new Date(),
    };
    const existingEvents = this.events.get(params.runId) ?? [];
    this.states.set(params.runId, newState);
    this.events.set(params.runId, [...existingEvents, params.event]);
    return { committed: true, newVersion };
  }

  async saveState(
    runId: string,
    state: State,
    expectedVersion: number,
  ): Promise<boolean> {
    const current = this.states.get(runId);
    if (current && current.version !== expectedVersion) {
      return false;
    }
    const newVersion = current ? current.version + 1 : 0;
    this.states.set(runId, {
      runId,
      state,
      version: newVersion,
      lastUpdated: new Date(),
    });
    return true;
  }

  async recordEvent(
    runId: string,
    event: TransitionEvent,
  ): Promise<void> {
    const existing = this.events.get(runId) ?? [];
    this.events.set(runId, [...existing, event]);
  }

  // ── Runtime convenience persistence methods (no-ops for in-memory) ────────

  async createRun(params: CreateRunParams): Promise<CreateRunResult> {
    if (this.states.has(params.runId)) {
      return { committed: false, version: 0, reason: "run_exists" };
    }
    this.states.set(params.runId, {
      runId: params.runId,
      state: params.initialState,
      version: 0,
      lastUpdated: new Date(),
    });
    if (params.contract) {
      this.contracts.set(params.contract.contractId, params.contract);
      this.runContractLinks.set(params.runId, params.contract.contractId);
    }
    if (params.creationEvent) {
      this.events.set(params.runId, [params.creationEvent]);
    }
    if (params.budget) {
      this.budgets.set(params.runId, params.budget);
    }
    return { committed: true, version: 0 };
  }

  async saveContract(contract: ContractRecord): Promise<void> {
    this.contracts.set(contract.contractId, contract);
  }

  async loadContract(contractId: string): Promise<ContractRecord | null> {
    return this.contracts.get(contractId) ?? null;
  }

  async loadContractForRun(runId: string): Promise<ContractRecord | null> {
    const contractId = this.runContractLinks.get(runId);
    if (!contractId) return null;
    return this.contracts.get(contractId) ?? null;
  }

  async loadEvents(runId: string): Promise<readonly TransitionEvent[]> {
    return [...(this.events.get(runId) ?? [])];
  }

  async loadRecoveryAttempts(runId: string): Promise<readonly RecoveryAttemptData[]> {
    return [...(this.recoveryAttempts.get(runId) ?? [])];
  }

  async loadCircuitBreaker(name: string): Promise<CircuitBreakerRow | null> {
    return this.circuitBreakers.get(name) ?? null;
  }

  async loadVerificationResults(runId: string): Promise<readonly VerificationResultData[]> {
    return [...(this.verificationResults.get(runId) ?? [])];
  }

  async loadEvidence(runId: string): Promise<readonly EvidenceData[]> {
    return [...(this.evidenceItems.get(runId) ?? [])];
  }

  async loadCompletionDecision(runId: string): Promise<CompletionDecisionData | null> {
    return this.completionDecisions.get(runId) ?? null;
  }

  async loadRun(runId: string): Promise<LoadedRun | null> {
    const state = this.states.get(runId) ?? null;
    if (!state && !this.runContractLinks.has(runId)) return null;
    const contract = await this.loadContractForRun(runId);
    return {
      runId,
      state,
      contract,
      events: await this.loadEvents(runId),
      recoveryAttempts: await this.loadRecoveryAttempts(runId),
      circuitBreakers: [...this.circuitBreakers.values()],
      cancellationPhase: this.phases.get(runId) ?? null,
      budget: await this.loadContextBudget(runId),
      verificationResults: await this.loadVerificationResults(runId),
      evidence: await this.loadEvidence(runId),
      completionDecision: this.completionDecisions.get(runId) ?? null,
    };
  }

  async initializeRun(_runId: string, _state: State): Promise<void> {
    // In-memory: state is created lazily on first saveState/commitTransition
  }

  async associateContract(runId: string, contractId: string): Promise<void> {
    this.runContractLinks.set(runId, contractId);
  }

  async saveVerificationResult(runId: string, result: VerificationResultData): Promise<void> {
    const existing = this.verificationResults.get(runId) ?? [];
    this.verificationResults.set(runId, [
      ...existing.filter((r) => r.checkId !== result.checkId),
      result,
    ]);
  }

  async saveEvidence(evidence: EvidenceData): Promise<void> {
    const existing = this.evidenceItems.get(evidence.runId) ?? [];
    this.evidenceItems.set(evidence.runId, [
      ...existing.filter((e) => e.id !== evidence.id),
      evidence,
    ]);
  }

  async saveCompletionDecision(decision: CompletionDecisionData): Promise<void> {
    this.completionDecisions.set(decision.runId, decision);
  }

  async recordRecoveryAttempt(attempt: RecoveryAttemptData): Promise<void> {
    const existing = this.recoveryAttempts.get(attempt.runId) ?? [];
    this.recoveryAttempts.set(attempt.runId, [...existing, attempt]);
  }

  async saveCircuitBreaker(name: string, state: Record<string, unknown>): Promise<void> {
    this.circuitBreakers.set(name, {
      name,
      state: String(state.state ?? "closed"),
      failure_count: Number(state.failureCount ?? 0),
      last_failure_at: state.lastFailureAt
        ? new Date(state.lastFailureAt as Date).toISOString()
        : null,
      last_state_change_at: new Date(
        (state.lastStateChangeAt as Date) ?? new Date(),
      ).toISOString(),
      total_successes: Number(state.totalSuccesses ?? 0),
      total_failures: Number(state.totalFailures ?? 0),
      half_open_successes: Number(state.halfOpenSuccesses ?? 0),
      half_open_attempts: Number(state.halfOpenAttempts ?? 0),
    });
  }

  async saveContextBudget(runId: string, budget: ContextBudgetData): Promise<void> {
    this.budgets.set(runId, budget);
  }

  async loadContextBudget(runId: string): Promise<ContextBudgetRow | null> {
    const budget = this.budgets.get(runId);
    if (!budget) return null;
    return {
      run_id: runId,
      total_budget: budget.totalBudget,
      mandatory_cost: budget.mandatoryCost,
      high_value_cost: budget.highValueCost,
      optional_cost: budget.optionalCost,
      remaining_budget: budget.remainingBudget,
      is_over_budget: budget.isOverBudget ? 1 : 0,
      truncation_needed: budget.truncationNeeded,
      updated_at: new Date().toISOString(),
    };
  }

  async saveCancellationPhase(
    runId: string,
    phase: CancellationPhase,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this.phases.set(runId, { phase, details });
  }

  async loadCancellationPhase(runId: string): Promise<CancellationPhaseInfo | null> {
    return this.phases.get(runId) ?? null;
  }

  async close(): Promise<void> {
    this.states.clear();
    this.events.clear();
    this.budgets.clear();
    this.phases.clear();
  }
}
