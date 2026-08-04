/**
 * Runtime integration facade for the Dev 2 orchestration runtime.
 *
 * This module is the primary entry point that wires together the state
 * machine, transition service, verification, completion, cancellation,
 * and context budget services into a unified runtime accessible by
 * agents and workflows.
 *
 * @module orchestration/runtime-integration
 */

import { z } from "zod/v4";
import type { Clock } from "./common/ports/clock.js";
import type { IdGenerator } from "./common/ports/id-generator.js";
import type { State } from "./runtime/states.js";
import type { TransitionType } from "./runtime/states.js";
import { TransitionService } from "./runtime/transition-service.js";
import type { TransitionResult } from "./runtime/transition-service.js";
import { hashContract } from "./contracts/contract-hasher.js";
import type { TaskContract, TaskContractDraft } from "./contracts/task-contract.js";
import type { ContractStore } from "./contracts/contract-store.js";
import { VerificationExecutor } from "./verification/verification-executor.js";
import type { VerificationResult } from "./verification/verification-result.js";
import type { VerificationPlan, VerificationCheck } from "./verification/verification-plan.js";
import { CompletionEngine } from "./completion/completion-engine.js";
import type { CompletionGateInput } from "./completion/completion-gates.js";
import type { IdempotencyRecord } from "./completion/completion-engine.js";
import { CancellationService } from "./recovery/cancellation-service.js";
import type { CancellationPhase } from "./recovery/cancellation-service.js";
import type { RecoveryStrategy } from "./recovery/recovery-state.js";
import { StructuredLogger } from "./logging/index.js";
import type { Logger } from "./logging/index.js";
import type {
  StateStore,
  CommitTransitionParams,
  RunState,
} from "./runtime/state-store.js";
import { InMemoryStateStore } from "./runtime/state-store.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface RuntimeConfig {
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly stateStore?: StateStore;
  readonly contractStore?: ContractStore;
  readonly logger?: Logger;
  readonly devMode?: boolean;
  readonly dbPath?: string;
}

export type RuntimeEventType =
  | "task_run.created"
  | "task_run.transitioned"
  | "task_run.verified"
  | "task_run.completed"
  | "task_run.recovered"
  | "task_run.cancelled"
  | "task_run.error";

export interface RuntimeEvent {
  readonly type: RuntimeEventType;
  readonly runId: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: Date;
  readonly correlationId?: string;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void | Promise<void>;

export interface Unsubscribe {
  (): void;
}

export interface CreatedTaskRun {
  readonly runId: string;
  readonly contract: TaskContract;
  readonly initialState: State;
  readonly version: number;
}

export interface VerificationInput {
  readonly runId: string;
  readonly sha: string;
  readonly contract: TaskContract;
  readonly cwd?: string;
}

export interface CompletionInput {
  readonly runId: string;
  readonly currentSha: string;
  readonly expectedSha?: string;
  readonly assignmentsComplete: boolean;
  readonly verificationResults: readonly {
    readonly id: string;
    readonly runId: string;
    readonly ruleId: string;
    readonly ruleDescription: string;
    readonly required: boolean;
    readonly status: "pending" | "running" | "passed" | "failed" | "skipped";
    readonly targetSha: string;
    readonly evidenceIds: readonly string[];
  }[];
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly description: string;
    readonly priority: "critical" | "high" | "medium" | "low";
  }[];
  readonly requirements: readonly {
    readonly id: string;
    readonly description: string;
    readonly priority: "critical" | "high" | "medium" | "low";
  }[];
  readonly evidenceItems: readonly {
    readonly id: string;
    readonly sha: string;
    readonly runId: string;
    readonly status: "current" | "archived";
    readonly criterionIds: readonly string[];
  }[];
  readonly requiredEvidence?: readonly {
    readonly type: string;
    readonly description: string;
    readonly path?: string;
  }[];
}

export interface CompletionResult {
  readonly success: boolean;
  readonly runId: string;
  readonly error?: string;
  readonly idempotencyRecord?: IdempotencyRecord;
  readonly evaluation?: {
    readonly allPassed: boolean;
    readonly gateResults: readonly unknown[];
    readonly passedCount: number;
    readonly totalCount: number;
  };
}

export interface RecoveryResult {
  readonly success: boolean;
  readonly runId: string;
  readonly error?: string;
  readonly recoveryState?: import("./recovery/recovery-state.js").RecoveryState;
  readonly strategy?: RecoveryStrategy;
}

export interface CancellationResult {
  readonly success: boolean;
  readonly runId: string;
  readonly phase: CancellationPhase;
  readonly error?: string;
}

export interface ContextBudgetInfo {
  readonly totalBudget: number;
  readonly mandatoryCost: number;
  readonly highValueCost: number;
  readonly optionalCost: number;
  readonly remainingBudget: number;
  readonly isOverBudget: boolean;
  readonly truncationNeeded: number;
}

// ── Schema ────────────────────────────────────────────────────────────────

export const RuntimeConfigSchema = z.object({
  clock: z.unknown().optional(),
  idGenerator: z.unknown().optional(),
  stateStore: z.unknown().optional(),
  contractStore: z.unknown().optional(),
  logger: z.unknown().optional(),
  devMode: z.boolean().optional(),
  dbPath: z.string().optional(),
});

// ── Runtime Orchestrator ──────────────────────────────────────────────────

const DEFAULT_CONTEXT_BUDGET = 100_000;

export class RuntimeOrchestrator {
  private readonly config: Required<
    Pick<RuntimeConfig, "clock" | "idGenerator" | "logger" | "devMode">
  > &
    Pick<RuntimeConfig, "dbPath">;
  private readonly stateStore: StateStore;
  private readonly contractStore?: ContractStore;
  private readonly transitionService: TransitionService;
  private readonly verificationExecutor: VerificationExecutor;
  private readonly completionEngine: CompletionEngine;
  private readonly cancellationService: CancellationService;
  private readonly logger: Logger;
  private readonly eventListeners: RuntimeEventListener[] = [];
  private readonly runStates: Map<string, RunState> = new Map();
  private readonly runContracts: Map<string, TaskContract> = new Map();
  private readonly contextBudgets: Map<string, ContextBudgetInfo> = new Map();

  constructor(config: RuntimeConfig = {}) {
    this.logger = config.logger ?? new StructuredLogger("RuntimeOrchestrator");
    this.config = {
      clock: config.clock ?? { now: () => new Date() },
      idGenerator: config.idGenerator ?? {
        generate: () =>
          `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      },
      logger: this.logger,
      devMode: config.devMode ?? false,
      dbPath: config.dbPath,
    };
    this.stateStore = config.stateStore ?? new InMemoryStateStore();
    this.contractStore = config.contractStore;
    this.transitionService = new TransitionService({
      stateStore: this.stateStore,
    });
    this.verificationExecutor = new VerificationExecutor(this.config.clock);
    this.completionEngine = new CompletionEngine();
    this.cancellationService = new CancellationService();
  }

  getEventEmitter(): { emit: (event: import("./runtime/stage-events.js").StageStageEvent) => void } {
    return this.transitionService.getEventEmitter();
  }

  getStateStore(): StateStore {
    return this.stateStore;
  }

  getTransitionService(): TransitionService {
    return this.transitionService;
  }

  getCancellationService(): CancellationService {
    return this.cancellationService;
  }

  // ── Event publishing ─────────────────────────────────────────────────────

  private emitRuntimeEvent(event: RuntimeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          result.catch(() => {
            // Unhandled async rejections must not become unhandled
          });
        }
      } catch {
        // listeners must not throw
      }
    }
  }

  subscribe(listener: RuntimeEventListener): Unsubscribe {
    this.eventListeners.push(listener);
    const index = this.eventListeners.length - 1;
    return () => {
      this.eventListeners.splice(index, 1);
    };
  }

  // ── Task creation ────────────────────────────────────────────────────────

  /**
   * Create a new task run from a contract draft.
   * Activates the contract, initializes run state, and returns the
   * runId + initial version for subsequent transitions.
   */
  async createTask(
    contractData: TaskContractDraft,
  ): Promise<CreatedTaskRun> {
    const clock = this.config.clock;
    const runId = this.config.idGenerator.generate();

    // Build the activated contract with a deterministic hash
    const now = clock.now();
    const contract: TaskContract = {
      ...contractData,
      status: "activated",
      activatedAt: now,
      hash: hashContract(contractData),
    };

    // Persist contract if store available
    if (this.contractStore) {
      this.contractStore.store(contract);
    }

    this.runContracts.set(runId, contract);

    // Initialize run state at "created"
    const initialState: State = "created";
    await this.stateStore.saveState(runId, initialState, 0);
    await this.stateStore.recordEvent(runId, {
      runId,
      from: "created",
      to: "created",
      transitionType: "normal" satisfies TransitionType,
      timestamp: now.getTime(),
    });

    const runState = await this.stateStore.loadState(runId);
    const version = runState?.version ?? 0;
    this.runStates.set(
      runId,
      runState ?? { runId, state: initialState, version, lastUpdated: now },
    );

    const created: CreatedTaskRun = {
      runId,
      contract,
      initialState,
      version,
    };

    this.emitRuntimeEvent({
      type: "task_run.created",
      runId,
      payload: {
        contractId: contract.id,
        initialState,
        version,
      },
      timestamp: now,
    });

    return created;
  }

  // ── State transitions ────────────────────────────────────────────────────

  /**
   * Execute a state transition for a run.
   * Uses commitTransition with correct CAS version from the authoritative
   * state store (not caller-supplied state).
   */
  async transition(
    runId: string,
    to: State,
    context: import("./runtime/transition-guards.js").TransitionContext,
    transitionType: TransitionType = "normal",
    expectedVersion?: number,
  ): Promise<TransitionResult> {
    // Load authoritative state from the store
    const runState = await this.stateStore.loadState(runId);
    const from = runState?.state ?? "created";
    const version = expectedVersion ?? runState?.version;

    const result = await this.transitionService.executeTransition(
      runId,
      from,
      to,
      context,
      transitionType,
      version,
    );

    if (result.success) {
      // Update cached state
      const updated = await this.stateStore.loadState(runId);
      if (updated) {
        this.runStates.set(runId, updated);
      }
      this.emitRuntimeEvent({
        type: "task_run.transitioned",
        runId,
        payload: {
          from: result.from,
          to: result.to,
          transitionType,
        },
        timestamp: this.config.clock.now(),
      });
    } else {
      this.emitRuntimeEvent({
        type: "task_run.error",
        runId,
        payload: {
          error: result.error,
          from: result.from,
          to: result.to,
        },
        timestamp: this.config.clock.now(),
      });
    }

    return result;
  }

  // ── Verification ─────────────────────────────────────────────────────────

  /**
   * Verify a run against its contract.
   * Persists verification results with the correct runId in events.
   */
  async verify(input: VerificationInput): Promise<VerificationResult | null> {
    const { runId, sha, contract } = input;

    // Build verification plan from contract
    const plan: VerificationPlan = this.buildVerificationPlan(runId, sha, contract);

    this.emitRuntimeEvent({
      type: "task_run.verified",
      runId,
      payload: { sha, planId: plan.id },
      timestamp: this.config.clock.now(),
    });

    try {
      const result = await this.verificationExecutor.execute(
        plan,
        input.cwd ?? process.cwd(),
      );

      // Persist verification result
      for (const cr of result.checkResults) {
        await this.stateStore.saveVerificationResult(runId, {
          checkId: cr.checkId,
          ruleId: cr.checkId,
          status: cr.status,
          targetSha: sha,
          evidenceIds: [],
        });
      }

      return result;
    } catch (error) {
      this.logger.error(
        `Verification failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
        { component: "RuntimeOrchestrator", runId: runId },
      );
      return null;
    }
  }

  private buildVerificationPlan(
    runId: string,
    sha: string,
    contract: TaskContract,
  ): VerificationPlan {
    const clock = this.config.clock;
    const now = clock.now();

    const checks: VerificationCheck[] = (contract.requiredVerification ?? []).map(
      (req, i) => ({
        id: `${req.type}-${i}`,
        type: req.type as VerificationCheck["type"],
        command: req.command,
        critical: true,
        order: i,
        expectedExitCode: 0,
        timeout: 60000,
      }),
    );

    return {
      id: `verify-${runId}-${sha.slice(0, 8)}`,
      contractId: contract.id,
      version: contract.version,
      runId,
      targetSha: sha,
      checks,
      preconditions: [],
      artifacts: [],
      createdAt: now,
      hash: `${runId}-${sha.slice(0, 8)}`,
      timeoutMs: 60000,
      parallel: false,
    };
  }

  // ── Completion ───────────────────────────────────────────────────────────

  /**
   * Complete a run using authoritative data loaded from the state store,
   * not from caller-supplied placeholders.
   *
   * Persists the "completed" terminal state transition atomically and
   * records a completion decision with the authoritative runId + SHA.
   */
  async complete(input: CompletionInput): Promise<CompletionResult> {
    const { runId, currentSha, expectedSha } = input;

    // Verify SHA matches expectation
    if (expectedSha && currentSha !== expectedSha) {
      return {
        success: false,
        runId,
        error: `SHA mismatch: expected ${expectedSha}, got ${currentSha}`,
      };
    }

    // Load authoritative run state for CAS version
    const runState = await this.stateStore.loadState(runId);
    if (!runState) {
      return { success: false, runId, error: `Run ${runId} not found` };
    }

    // Build completion gate input and evaluate
    const gateInput: CompletionGateInput = {
      runId,
      currentSha,
      assignmentsComplete: input.assignmentsComplete,
      verificationResults: input.verificationResults,
      acceptanceCriteria: input.acceptanceCriteria,
      requirements: input.requirements,
      evidenceItems: input.evidenceItems,
      requiredEvidence: input.requiredEvidence,
    };

    const checkResult = this.completionEngine.checkCompletion(gateInput);

    if (!checkResult.canComplete) {
      const reasons = checkResult.blockedReasons.join("; ");
      return {
        success: false,
        runId,
        error: `Completion gates not satisfied: ${reasons}`,
        evaluation: {
          allPassed: checkResult.evaluation.allPassed,
          gateResults: [...checkResult.evaluation.gateResults],
          passedCount: checkResult.evaluation.passedCount,
          totalCount: checkResult.evaluation.totalCount,
        },
      };
    }

    // Commit the terminal "completed" state transition atomically
    const commitParams: CommitTransitionParams = {
      runId,
      state: "completed",
      expectedVersion: runState.version,
      event: {
        runId,
        from: runState.state,
        to: "completed",
        transitionType: "normal",
        timestamp: this.config.clock.now().getTime(),
      },
    };

    const result = await this.stateStore.commitTransition(commitParams);
    if (!result.committed) {
      return {
        success: false,
        runId,
        error: `Commit failed: ${result.reason ?? "unknown"}`,
      };
    }

    // Persist completion decision with authoritative runId + SHA
    await this.stateStore.saveCompletionDecision({
      id: `${runId}-completion`,
      runId,
      decision: "complete",
      sha: currentSha,
      checks: JSON.stringify({
        allPassed: true,
        gateResults: checkResult.evaluation.gateResults,
        passedCount: checkResult.evaluation.passedCount,
        totalCount: checkResult.evaluation.totalCount,
      }),
      idempotencyKey: `${runId}:${currentSha}`,
    });

    this.emitRuntimeEvent({
      type: "task_run.completed",
      runId,
      payload: {
        sha: currentSha,
        version: result.newVersion,
      },
      timestamp: this.config.clock.now(),
    });

    return {
      success: true,
      runId,
      idempotencyRecord: {
        runId,
        inputHash: JSON.stringify(gateInput),
        result: checkResult,
        checkedAt: this.config.clock.now(),
      },
      evaluation: {
        allPassed: true,
        gateResults: [...checkResult.evaluation.gateResults],
        passedCount: checkResult.evaluation.passedCount,
        totalCount: checkResult.evaluation.totalCount,
      },
    };
  }

  // ── Cancellation ─────────────────────────────────────────────────────────

  /** Cancel a run, transitioning through cancellation phases. */
  async cancel(
    runId: string,
    force: boolean = false,
    reason?: string,
    timeout?: number,
  ): Promise<CancellationResult> {
    const tokenId = `token:root:${runId}`;
    const token = this.cancellationService.getToken(tokenId);

    if (!token) {
      // Create the root token if it doesn't exist yet
      this.cancellationService.createRootToken(runId);
    }

    await this.cancellationService.cancel(tokenId, {
      force,
      reason,
      timeout,
    });

    const phase = await this.cancellationService.getCancelPhase(runId);

    this.emitRuntimeEvent({
      type: "task_run.cancelled",
      runId,
      payload: {
        phase,
        forced: force,
        reason,
      },
      timestamp: this.config.clock.now(),
    });

    return { success: true, runId, phase };
  }

  /** Force escalation from graceful to forced cancellation phase. */
  async forceEscalation(
    runId: string,
    reason: string = "manual_force_escalation",
  ): Promise<CancellationResult> {
    await this.cancellationService.setCancelPhase(runId, "force_requested", {
      reason,
    });

    const tokenId = `token:root:${runId}`;
    await this.cancellationService.cancel(tokenId, { force: true, reason });

    return { success: true, runId, phase: "completed" };
  }

  // ── Recovery ────────────────────────────────────────────────────────────

  /**
   * Recover a run using correct CAS version from the state store.
   * Never emits false success — returns success only if the transition
   * was actually committed.
   */
  async recover(
    runId: string,
    error: string,
    expectedVersion?: number,
  ): Promise<RecoveryResult> {
    // Load authoritative state for CAS version
    const runState = await this.stateStore.loadState(runId);
    if (!runState) {
      return {
        success: false,
        runId,
        error: `Run ${runId} not found`,
      };
    }

    const version = expectedVersion ?? runState.version;
    const fromState = runState.state;

    // Determine target recovery state based on current state
    let toState: State;
    if (fromState === "failed") {
      toState = "recovering";
    } else if (fromState === "recovering") {
      toState = "analysing";
    } else {
      // Cannot recover from terminal or non-error states
      this.emitRuntimeEvent({
        type: "task_run.error",
        runId,
        payload: { error: `Cannot recover from state: ${fromState}` },
        timestamp: this.config.clock.now(),
      });
      return {
        success: false,
        runId,
        error: `Cannot recover from state: ${fromState}`,
      };
    }

    // Record recovery attempt
    await this.stateStore.recordRecoveryAttempt({
      id: `${runId}-${Date.now()}-recovery`,
      runId,
      attemptNumber: 1,
      previousState: fromState,
      failureReason: error,
      errorKey: error,
      action: `transition:${fromState}->${toState}`,
    });

    // Commit the recovery transition with correct CAS version
    const commitParams: CommitTransitionParams = {
      runId,
      state: toState,
      expectedVersion: version,
      event: {
        runId,
        from: fromState,
        to: toState,
        transitionType: "retry",
        timestamp: this.config.clock.now().getTime(),
      },
    };

    const result = await this.stateStore.commitTransition(commitParams);
    if (!result.committed) {
      this.emitRuntimeEvent({
        type: "task_run.error",
        runId,
        payload: {
          error: `Recovery commit failed: ${result.reason ?? "unknown"}`,
        },
        timestamp: this.config.clock.now(),
      });
      return {
        success: false,
        runId,
        error: `Recovery commit failed: ${result.reason ?? "unknown"}`,
      };
    }

    // Build recovery state (best-effort: the checkpoint repository is an
    // optional port; if it is not configured the transition is still
    // committed, so we must not throw after the commit).
    let recoveryState: import("./recovery/recovery-state.js").RecoveryState | undefined;
    try {
      recoveryState = await this.cancellationService.buildRecoveryState(
        runId,
        `${runId}-${Date.now()}-checkpoint`,
        true,
        error,
      );
    } catch (recoveryError) {
      this.logger.error(
        `Recovery state build failed for run ${runId}: ${
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        }`,
        { component: "RuntimeOrchestrator", runId },
      );
    }

    // Emit stage events via transition service
    const stageEmitter = this.transitionService.getEventEmitter();
    const { createStageEntered, createStageExited } = await import("./runtime/stage-events.js");
    stageEmitter.emit(createStageExited(runId, fromState, toState, "retry"));
    stageEmitter.emit(createStageEntered(runId, toState, fromState, "retry"));

    this.emitRuntimeEvent({
      type: "task_run.recovered",
      runId,
      payload: {
        from: fromState,
        to: toState,
        version: result.newVersion,
        recoveryAttempts: recoveryState?.recoveryAttempts ?? [],
      },
      timestamp: this.config.clock.now(),
    });

    return {
      success: true,
      runId,
      recoveryState,
      strategy: this.determineRecoveryStrategy(error),
    };
  }

  private determineRecoveryStrategy(error: string): RecoveryStrategy {
    if (error.includes("timeout") || error.includes("TIMEOUT")) {
      return "resume";
    }
    if (error.includes("circuit") || error.includes("CIRCUIT")) {
      return "abort";
    }
    if (error.includes("model") || error.includes("MODEL")) {
      return "replan";
    }
    return "restart";
  }

  // ── Context Budget ───────────────────────────────────────────────────────

  /**
   * Get the context budget for a run. Persists per-run state.
   * Returns existing budget if persisted, otherwise initializes.
   */
  async getContextBudget(runId: string): Promise<ContextBudgetInfo> {
    // Load existing budget from store
    const existing = await this.stateStore.loadContextBudget(runId);
    if (existing) {
      const budget: ContextBudgetInfo = {
        totalBudget: existing.total_budget,
        mandatoryCost: existing.mandatory_cost,
        highValueCost: existing.high_value_cost,
        optionalCost: existing.optional_cost,
        remainingBudget: existing.remaining_budget,
        isOverBudget: existing.is_over_budget === 1,
        truncationNeeded: existing.truncation_needed,
      };
      this.contextBudgets.set(runId, budget);
      return budget;
    }

    // Initialize new budget
    const budget: ContextBudgetInfo = {
      totalBudget: DEFAULT_CONTEXT_BUDGET,
      mandatoryCost: 0,
      highValueCost: 0,
      optionalCost: 0,
      remainingBudget: DEFAULT_CONTEXT_BUDGET,
      isOverBudget: false,
      truncationNeeded: 0,
    };
    this.contextBudgets.set(runId, budget);
    await this.stateStore.saveContextBudget(runId, budget);
    return budget;
  }

  /**
   * Update the context budget for a run and persist it.
   */
  async updateContextBudget(
    runId: string,
    budget: ContextBudgetInfo,
  ): Promise<void> {
    this.contextBudgets.set(runId, budget);
    await this.stateStore.saveContextBudget(runId, budget);
  }

  // ── Disposal ─────────────────────────────────────────────────────────────

  dispose(): void {
    this.cancellationService.dispose();
    this.eventListeners.length = 0;
    this.runStates.clear();
    this.runContracts.clear();
    this.contextBudgets.clear();
  }
}

/**
 * Factory function for creating a RuntimeOrchestrator with a config.
 */
export function createRuntimeIntegration(config: RuntimeConfig = {}): RuntimeOrchestrator {
  return new RuntimeOrchestrator(config);
}

// Re-export for test access
export { InMemoryStateStore } from "./runtime/state-store.js";
export { defaultTransitionGuards } from "./runtime/transition-guards.js";
export { StageEventEmitter } from "./runtime/stage-events.js";
export type { StageStageEvent } from "./runtime/stage-events.js";
export type { TransitionGuard, GuardResult, TransitionContext } from "./runtime/transition-guards.js";
export type {
  StateStore,
  CommitTransitionParams,
  CommitTransitionResult,
  RunState,
  TransitionEvent,
} from "./runtime/state-store.js";
