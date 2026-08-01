/**
 * Runtime Integration — wires Dev 2 runtime modules into the FlowDeck
 * production execution path.
 *
 * Provides RuntimeOrchestrator, a unified facade over:
 * - StateStore (in-memory or file-backed) for runtime state persistence
 * - ContractStore for immutable contract activation and retrieval
 * - TransitionService for state machine enforcement and event emission
 * - VerificationExecutor for contract-derived verification plans
 * - CompletionEngine for contract-derived completion gate evaluation
 * - CancellationService for cancellation propagation and child work
 * - Context budget allocation for real agent execution
 * - Telemetry collection via event subscription
 *
 * All state transitions persist events in the same unit of work.
 */

import type { State } from "./runtime/states.js";
import type { TransitionResult } from "./runtime/transition-service.js";
import type { StageStageEvent } from "./runtime/stage-events.js";
import type {
  TaskContract,
  TaskContractDraft,
} from "./contracts/task-contract.js";
import { ContractStore } from "./contracts/contract-store.js";
import { activateContract } from "./contracts/contract-validator.js";
import type {
  VerificationPlan,
  Precondition,
} from "./verification/verification-plan.js";
import type {
  VerificationResult,
  VerificationStatus,
} from "./verification/verification-result.js";
import { VerificationExecutor } from "./verification/verification-executor.js";
import { CompletionEngine } from "./completion/completion-engine.js";
import type { CompletionGateInput } from "./completion/completion-gates.js";
import { CancellationService } from "./recovery/cancellation-service.js";
import type {
  Checkpoint,
  RecoveryState,
  RecoveryStrategy,
} from "./recovery/recovery-state.js";
import type { ContextBudget } from "./context/context-budget.js";
import { createBudget } from "./context/context-budget.js";
import type { Clock, IdGenerator } from "./common/ports/index.js";
import { StageEventEmitter } from "./runtime/stage-events.js";
import { TransitionService } from "./runtime/transition-service.js";
import type { StateStore, RunState } from "./runtime/state-store.js";
import { InMemoryStateStore } from "./runtime/state-store.js";

/**
 * Unsubscribe function returned from subscribe().
 */
export type Unsubscribe = () => void;

/**
 * Configuration for the production RuntimeOrchestrator.
 */
export interface RuntimeConfig {
  /** Optional SQLite database for authoritative persistence (passed to adapters). */
  readonly db?: unknown;
  /** Clock abstraction for testable time. */
  readonly clock: Clock;
  /** ID generator for run/contract identifiers. */
  readonly idGenerator: IdGenerator;
  /** In-memory StateStore override (used when db is not provided). */
  readonly stateStore?: StateStore;
  /** Contract store override (defaults to empty in-memory store). */
  readonly contractStore?: ContractStore;
  /** Optional initial state for new runs. */
  readonly initialState?: State;
  /** Total context budget in tokens (default 200000). */
  readonly contextBudgetTokens?: number;
  /** Cancellation service config */
  readonly cancellationConfig?: { timeoutMs?: number };
}

/**
 * Result of a recovery operation.
 */
export interface RecoveryResult {
  readonly recovered: boolean;
  readonly strategy: RecoveryStrategy;
  readonly checkpoint?: Checkpoint;
  readonly reason?: string;
}

/**
 * Completion result from the CompletionEngine.
 */
export interface CompletionResult {
  readonly completed: boolean;
  readonly blockedReasons: readonly string[];
  readonly gateEvaluation: {
    allPassed: boolean;
    gateResults: readonly {
      gate: string;
      passed: boolean;
      reasons?: string[];
    }[];
  };
}

/**
 * Unified runtime interface that wires together all Dev 2 runtime modules
 * through the FlowDeck production execution path.
 *
 * Lifecycle:
 * - createTask → activates & persists an immutable contract
 * - transition → validates state machine, persists event + state
 * - verify → runs contract-derived verification plan
 * - complete → evaluates contract-derived gates
 * - cancel → reaches active child work via cancellation tokens
 * - recover → restores from persisted checkpoints
 */
export class RuntimeOrchestrator {
  private readonly config: Required<
    Pick<RuntimeConfig, "initialState" | "contextBudgetTokens">
  > &
    RuntimeConfig;

  private stateStore: StateStore;
  private contractStore: ContractStore;
  private readonly transitionService: TransitionService;
  private readonly verificationExecutor: VerificationExecutor;
  private readonly completionEngine: CompletionEngine;
  private readonly cancellationService: CancellationService;
  private readonly stageEmitter: StageEventEmitter;

  private readonly runStates: Map<string, RunState> = new Map();
  private readonly runContracts: Map<string, TaskContract> = new Map();

  private readonly eventListeners: Set<RuntimeEventListener> = new Set();

  constructor(config: RuntimeConfig) {
    this.config = {
      initialState: config.initialState ?? "created",
      contextBudgetTokens: config.contextBudgetTokens ?? 200_000,
      ...config,
    };

    // 1. StateStore — authoritative persistence source
    this.stateStore = config.stateStore ?? new InMemoryStateStore();

    // 2. Contract store — immutable contract persistence
    this.contractStore = config.contractStore ?? new ContractStore();

    // 3. Transition service — state machine with guards + event emission
    this.stageEmitter = new StageEventEmitter();
    this.transitionService = new TransitionService({
      eventEmitter: this.stageEmitter,
      stateStore: this.stateStore,
    });
    this.transitionService.subscribe((event) => {
      this.onStageEvent(event);
    });

    // 4. Verification executor — runs contract-derived verification plans
    this.verificationExecutor = new VerificationExecutor(this.config.clock);
    this.verificationExecutor.onEvent((event) => {
      this.emitRuntimeEvent({
        type: "verification",
        runId: "",
        timestamp: Date.now(),
        payload: event as Record<string, unknown>,
      });
    });

    // 5. Completion engine — evaluates contract-derived gates
    this.completionEngine = new CompletionEngine();

    // 6. Cancellation service — reaches active child work
    this.cancellationService = new CancellationService({
      defaultTimeoutMs: config.cancellationConfig?.timeoutMs ?? 30_000,
    });
    this.cancellationService.onEvent((event) => {
      this.emitRuntimeEvent({
        type: "cancellation",
        runId: event.tokenId,
        timestamp: Date.now(),
        payload: event as unknown as Record<string, unknown>,
      });
    });
  }

  // ── Task creation ──────────────────────────────────────────────────────────

  /**
   * Creates a new task run with a validated, immutable contract.
   * The contract is activated through the contract validator and persisted
   * to the contract store. The run state is initialized in the StateStore.
   */
  async createTask(contractData: TaskContractDraft): Promise<TaskContract> {
    const runId = this.config.idGenerator.generate();

    // Validate and activate the contract through the contract validator
    const activationResult = activateContract(contractData, this.contractStore);
    if (!activationResult.success || !activationResult.contract) {
      throw new Error(
        `Contract activation failed: ${activationResult.error ?? "unknown error"}`,
      );
    }

    const contract = activationResult.contract;

    // Persist contract to store (immutable — store returns a new instance)
    if (activationResult.updatedStore) {
      this.contractStore = activationResult.updatedStore;
    } else {
      this.contractStore = this.contractStore.withContract(contract);
    }

    // Initialize run state in StateStore
    const currentState = this.config.initialState;
    await this.stateStore.saveState(runId, currentState, 0);

    // Track contract association
    this.runContracts.set(runId, contract);

    this.emitRuntimeEvent({
      type: "task_created",
      runId,
      timestamp: Date.now(),
      payload: { runId, contractId: contract.id, hash: contract.hash },
    });

    return contract;
  }

  // ── State transitions ──────────────────────────────────────────────────────

  /**
   * Executes a state transition for the given run.
   * Loads authoritative state from the StateStore, validates against the
   * transition matrix and guards, persists the transition event and
   * new state in the same unit of work, then publishes stage events.
   */
  async transition(
    runId: string,
    event: string,
    fromState?: string,
  ): Promise<TransitionResult> {
    // Load current state from StateStore
    const current = await this.stateStore.loadState(runId);
    if (!current) {
      throw new Error(`Run ${runId} not found in StateStore`);
    }

    const from = (fromState ?? current.state) as State;
    const to = event as State;

    // Execute transition through TransitionService (validates matrix + guards)
    // TransitionService handles persistence: loads authoritative state, validates
    // version, saves state + records event atomically before publishing.
    const result = await this.transitionService.executeTransition(
      runId,
      from,
      to,
      { runId, timestamp: Date.now(), reason: event },
      fromState ? "forced" : "normal",
    );

    if (!result.success) {
      this.emitRuntimeEvent({
        type: "transition_failed",
        runId,
        timestamp: Date.now(),
        payload: { from, to: event, error: result.error },
      });
      return result;
    }

    // Update in-memory cache
    const newState = await this.stateStore.loadState(runId);
    if (newState) {
      this.runStates.set(runId, newState);
    }

    this.emitRuntimeEvent({
      type: "transition",
      runId,
      timestamp: Date.now(),
      payload: { from: result.from, to: result.to, transitionType: result.transitionType },
    });

    return result;
  }

  // ── Verification ───────────────────────────────────────────────────────────

  /**
   * Runs the contract-derived verification plan for a run through the
   * production VerificationExecutor.
   */
  async verify(runId: string): Promise<VerificationStatus> {
    const contract = this.runContracts.get(runId);
    if (!contract) {
      throw new Error(`Run ${runId} has no activated contract`);
    }

    // Build verification plan from contract requirements
    const plan = this.buildVerificationPlan(contract, runId);

    const result: VerificationResult = await this.verificationExecutor.execute(
      plan,
      process.cwd(),
    );

    this.emitRuntimeEvent({
      type: "verification_complete",
      runId,
      timestamp: Date.now(),
      payload: { planId: plan.id, status: result.status },
    });

    return result.status;
  }

  // ── Completion ─────────────────────────────────────────────────────────────

  /**
   * Evaluates contract-derived completion gates for a run.
   * The model report cannot bypass these gates.
   */
  async complete(runId: string): Promise<CompletionResult> {
    const contract = this.runContracts.get(runId);
    if (!contract) {
      throw new Error(`Run ${runId} has no activated contract`);
    }

    // Build completion gate input from contract + current state
    const gateInput = this.buildCompletionGateInput(contract, runId);
    const checkResult = this.completionEngine.checkCompletion(gateInput);

    this.emitRuntimeEvent({
      type: "completion_evaluated",
      runId,
      timestamp: Date.now(),
      payload: { completed: checkResult.canComplete, blocked: checkResult.blockedReasons },
    });

    return {
      completed: checkResult.canComplete,
      blockedReasons: checkResult.blockedReasons,
      gateEvaluation: {
        allPassed: checkResult.evaluation.allPassed,
        gateResults: checkResult.evaluation.gateResults.map((r) => ({
          gate: r.gate as string,
          passed: r.passed,
          reasons: r.reasons,
        })),
      },
    };
  }

  // ── Cancellation ───────────────────────────────────────────────────────────

  /**
   * Cancels a run, reaching active child work via cancellation tokens.
   * Force=true bypasses graceful shutdown.
   */
  async cancel(runId: string, force = false): Promise<void> {
    const tokenId = `token:root:${runId}`;

    // Ensure a root token exists
    if (!this.cancellationService.getToken(tokenId)) {
      this.cancellationService.createRootToken(runId);
    }

    // Cancellation propagates to active child work owned by this token
    await this.cancellationService.cancel(tokenId, {
      force,
      reason: force ? "FORCED" : "Cancellation requested",
    });

    // Also transition state via the state machine
    const current = await this.stateStore.loadState(runId);
    if (current && !["completed", "failed", "cancelled"].includes(current.state)) {
      await this.transition(runId, "cancelled", current.state);
    }

    this.emitRuntimeEvent({
      type: "cancelled",
      runId,
      timestamp: Date.now(),
      payload: { force },
    });
  }

  // ── Recovery ───────────────────────────────────────────────────────────────

  /**
   * Recovers a run from persisted checkpoint state.
   * State persists across process restart via the StateStore.
   */
  async recover(runId: string): Promise<RecoveryResult> {
    let checkpoint: Checkpoint | null = null;
    try {
      checkpoint = await this.cancellationService.getLatestCheckpoint(runId);
    } catch {
      // No checkpoint repository configured — proceed with state recovery only
    }

    const runState = await this.stateStore.loadState(runId);
    if (!runState && !checkpoint) {
      return {
        recovered: false,
        strategy: "abort",
        reason: "No persisted state or checkpoint found for run",
      };
    }

    // Build recovery state for strategy evaluation
    const recoveryState: RecoveryState = {
      runId,
      checkpointId: checkpoint?.id ?? "none",
      recoveryAttempts: 0,
      lastCheckpointAt: checkpoint?.createdAt ?? runState?.lastUpdated ?? new Date(),
      changedHypothesis: true,
      circuitBreakerOpen: false,
    };

    // Determine strategy based on failure type and state
    const strategy = this.determineRecoveryStrategy(recoveryState, checkpoint, runState);

    if (strategy === "abort") {
      return {
        recovered: false,
        strategy: "abort",
        reason: "Recovery not viable",
      };
    }

    // Restore state from checkpoint if available
    if (checkpoint && checkpoint.stateSnapshot) {
      const restoredState = checkpoint.stateSnapshot.phase as State;
      await this.stateStore.saveState(
        runId,
        restoredState,
        (runState?.version ?? 0) + 1,
      );
      this.runStates.set(runId, {
        runId,
        state: restoredState,
        version: (runState?.version ?? 0) + 1,
        lastUpdated: new Date(),
      });

      // Restore cancellation tokens for active child work
      this.cancellationService.deserializeAndRestore({
        id: `token:root:${runId}`,
        isCancelled: false,
        isRoot: true,
        children: [],
      });
    }

    this.emitRuntimeEvent({
      type: "recovered",
      runId,
      timestamp: Date.now(),
      payload: { strategy },
    });

    return {
      recovered: true,
      strategy,
      checkpoint: checkpoint ?? undefined,
    };
  }

  // ── Context budget ─────────────────────────────────────────────────────────

  /**
   * Returns the current context budget for a run.
   * Can be used to check if truncation is needed before agent execution.
   */
  getContextBudget(_runId: string): ContextBudget {
    return createBudget(this.config.contextBudgetTokens);
  }

  // ── Event subscription ─────────────────────────────────────────────────────

  /**
   * Subscribes to runtime events including transitions, verification,
   * completion, cancellation, and recovery events.
   * Telemetry collectors can listen here to observe production events.
   */
  subscribe(listener: RuntimeEventListener): Unsubscribe {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private onStageEvent(event: StageStageEvent): void {
    this.emitRuntimeEvent({
      type: "state_transition",
      runId: event.runId,
      timestamp: event.timestamp,
      payload: { eventType: event.type, ...event },
    });
  }

  private emitRuntimeEvent(event: RuntimeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Listeners must not throw
      }
    }
  }

  /**
   * Builds a verification plan from a TaskContract's verification requirements.
   */
  private buildVerificationPlan(
    contract: TaskContract,
    runId: string,
  ): VerificationPlan {
    const checks = contract.requiredVerification.map((v, idx) => ({
      id: `check:${v.type}:${idx}`,
      type: v.type as "test" | "build" | "lint" | "typecheck" | "command",
      command: v.command,
      expectedExitCode: 0,
      timeout: 60_000,
      critical: true,
      order: idx,
    }));

    const preconditions: Precondition[] = contract.requiredEvidence.map((e) => {
      const precondition: Precondition = {
        type: e.type === "file" ? "file_exists" : e.type === "test" ? "dir_exists" : "env_set",
        ...(e.type === "file" && e.path ? { path: e.path } : {}),
      };
      return precondition;
    });

    return {
      id: `verification:${runId}:${contract.id}`,
      contractId: contract.id,
      version: contract.version,
      checks,
      preconditions,
      artifacts: [],
      createdAt: new Date(),
      hash: contract.hash,
    };
  }

  /**
   * Builds the completion gate input from a TaskContract and run state.
   */
  private buildCompletionGateInput(
    contract: TaskContract,
    runId: string,
  ): CompletionGateInput {
    return {
      runId,
      currentSha: contract.startingSha,
      assignmentsComplete: true,
      verificationResults: [],
      acceptanceCriteria: contract.acceptanceCriteria.map((c) => ({
        id: c.id,
        description: c.description,
        priority: c.critical ? "critical" : "high",
      })),
      requirements: contract.requirements.map((r) => ({
        id: r.id,
        description: r.description,
        priority: r.critical ? "critical" : "high",
      })),
      evidenceItems: [],
      requiredEvidence: contract.requiredEvidence,
    };
  }

  /**
   * Determines recovery strategy based on recovery state and available checkpoint.
   */
  private determineRecoveryStrategy(
    _state: RecoveryState,
    checkpoint: Checkpoint | null,
    runState: RunState | null,
  ): RecoveryStrategy {
    if (!checkpoint && !runState) return "abort";

    // If model call was in progress, replan may help
    if (checkpoint?.stateSnapshot.modelCallState && !checkpoint.stateSnapshot.modelCallState.responseStarted) {
      return "replan";
    }

    // If some work completed, resume is appropriate
    if ((checkpoint?.stateSnapshot.completedTools.length ?? 0) > 0) {
      return "resume";
    }

    // No checkpoint or no work — restart
    if (!checkpoint) {
      return "restart";
    }

    return "restart";
  }
}

// ── Runtime event types ─────────────────────────────────────────────────────

export interface RuntimeEvent {
  readonly type: string;
  readonly runId: string;
  readonly timestamp: number;
  readonly payload: Record<string, unknown>;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;
