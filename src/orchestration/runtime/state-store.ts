/**
 * State persistence interfaces for FlowDeck orchestration runtime.
 * @module orchestration/runtime/state-store
 */

import type { State, TransitionType } from "./states.js";

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

  async initializeRun(_runId: string, _state: State): Promise<void> {
    // In-memory: state is created lazily on first saveState/commitTransition
  }

  async associateContract(_runId: string, _contractId: string): Promise<void> {
    // In-memory: associations tracked via runContracts map in orchestrator
  }

  async saveVerificationResult(_runId: string, _result: VerificationResultData): Promise<void> {
    // No-op for in-memory store
  }

  async saveEvidence(_evidence: EvidenceData): Promise<void> {
    // No-op for in-memory store
  }

  async saveCompletionDecision(_decision: CompletionDecisionData): Promise<void> {
    // No-op for in-memory store
  }

  async recordRecoveryAttempt(_attempt: RecoveryAttemptData): Promise<void> {
    // No-op for in-memory store
  }

  async saveCircuitBreaker(_name: string, _state: Record<string, unknown>): Promise<void> {
    // No-op for in-memory store
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
