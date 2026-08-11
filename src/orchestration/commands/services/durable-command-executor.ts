import type {
  CommandDefinition,
  CommandInvocation,
  CommandResult,
  ExecutableCommandPlan,
} from "../domain/command-definition";
import { CommandRegistry } from "../domain/command-registry";
import { validateCommandInput, CommandValidationException } from "../domain/command-validator";
import { enforceCommandSecurity } from "../security/command-security";
import { commandRequestFingerprint } from "../domain/command-fingerprint";
import { CommandIdempotencyConflictError } from "../persistence/sqlite-command-invocation-repository";
import type { SqliteCommandInvocationRepository } from "../persistence/sqlite-command-invocation-repository";
import type { ProductionOrchestrationRuntime } from "../../composition";
import type { ExecutionPlan } from "../../execution/contracts";
import type { AssignmentBindingCoordinator } from "../../execution/assignment-binding-coordinator";
import type { CommandRecoveryClaim } from "./command-recovery-claim";
import { randomUUID } from "crypto";

export type CommandRecoveryErrorCode =
  | "COMMAND_INVOCATION_NOT_FOUND"
  | "COMMAND_TERMINAL"
  | "COMMAND_RECOVERY_CONFLICT"
  | "CANONICAL_RECOVERY_STATE_MISSING"
  | "COMMAND_RECOVERY_GRAPH_CONTRADICTION"
  | "COMMAND_HISTORICAL_VERSION_UNRESOLVABLE"
  | "CANONICAL_SCHEDULER_UNAVAILABLE"
  | "CANONICAL_AGENT_EXECUTOR_UNAVAILABLE"
  | "CANONICAL_VERIFIER_UNAVAILABLE"
  | "CANONICAL_COMPLETION_UNAVAILABLE"
  | "CANONICAL_EXECUTION_REPOSITORY_UNAVAILABLE"
  | "CANONICAL_CANCELLATION_UNAVAILABLE"
  | "COMMAND_CANCELLED"
  | "CANONICAL_SCHEDULER_FAILED"
  | "CANONICAL_VERIFICATION_FAILED"
  | "CANONICAL_COMPLETION_BLOCKED"
  | "COMMAND_EXECUTION_ERROR";

export class CommandRecoveryError extends Error {
  constructor(public readonly code: CommandRecoveryErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "CommandRecoveryError";
  }
}

export interface CommandFaultHook {
  /** Called after the canonical dispatch/schedule completes but before
   *  verification/completion. Dependency-injected; never persisted. Used by
   *  tests to simulate a crash at a precise fault boundary. */
  afterDispatch?(invocationId: string): void;
  /** Called immediately before the Completion Engine evaluation, after
   *  verification results/evidence have been persisted. Dependency-injected;
   *  never persisted. Used by tests to simulate a crash between verification
   *  and completion (R12-R14 recovery boundary). */
  beforeCompletion?(invocationId: string): void;
}

export class CommandCompiler {
  constructor(private readonly registry: CommandRegistry) {}

  async compile(
    commandIdOrAlias: string,
    version: number | undefined,
    invocationId: string,
    input: Record<string, unknown>,
  ): Promise<{ definition: CommandDefinition; plan: ExecutableCommandPlan }> {
    const definition = this.registry.resolve(commandIdOrAlias, version);
    const validation = validateCommandInput(definition, input);

    if (!validation.valid) {
      throw new CommandValidationException(validation.errors);
    }

    const invocation: CommandInvocation = {
      invocationId,
      commandId: definition.id,
      commandVersion: definition.version,
      idempotencyKey: (input.idempotencyKey as string) ?? `ik_${invocationId}`,
      status: "accepted",
      input,
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    enforceCommandSecurity(invocation);

    if (definition.compileHandler) {
      const plan = await definition.compileHandler(invocation);
      return { definition, plan };
    }

    // Default compilation plan into existing FlowDeck constructs
    const plan: ExecutableCommandPlan = {
      commandId: definition.id,
      commandVersion: definition.version,
      invocationId,
      strategy: definition.strategy,
      taskRunId: (input.taskRunId as string) ?? `run_${randomUUID()}`,
      contractId: (input.contractId as string) ?? `contract_${definition.id.replace(/\//g, "_")}`,
      workstreams: [
        {
          id: `ws_${randomUUID()}`,
          name: `${definition.id}-primary-stream`,
          agentRole: "orchestrator",
          dependencies: [],
        },
      ],
      verificationRequirements: definition.verificationPolicy,
      tokenBudget: definition.tokenPolicy,
    };

    return { definition, plan };
  }
}

export interface CommandExecutorRuntimeDeps {
  services: ProductionOrchestrationRuntime["services"];
  executionRepository: ProductionOrchestrationRuntime["executionRepository"];
  executionScheduler: ProductionOrchestrationRuntime["executionScheduler"];
  worktreeExecutionService?: ProductionOrchestrationRuntime["worktreeExecutionService"];
  agentExecutor?: ProductionOrchestrationRuntime["agentExecutor"];
  commandVerification?: {
    verifyCommand(input: { runId: string; commandId: string; commandVersion: number; sourceSha: string; invocationId: string }): Promise<{ passed: boolean; verificationResults: readonly unknown[]; evidenceItems: readonly unknown[] }>;
  };
  commandCompletion?: {
    evaluateCommand(input: { runId: string; commandId: string; commandVersion: number; sourceSha: string; invocationId: string; verificationResults: readonly unknown[]; evidenceItems: readonly unknown[]; verificationRequired: boolean }): Promise<{ outcome: string; decisionId: string }>;
  };
  assignmentBindingCoordinator: AssignmentBindingCoordinator;
  recoveryClaim: CommandRecoveryClaim;
  faultHook?: CommandFaultHook;
}

export class DurableCommandExecutor {
  private readonly compiler: CommandCompiler;

  constructor(
    private readonly registry: CommandRegistry,
    private readonly invocationRepo: SqliteCommandInvocationRepository,
    private readonly runtime: CommandExecutorRuntimeDeps,
  ) {
    this.compiler = new CommandCompiler(this.registry);
  }

  async executeCommand(
    commandIdOrAlias: string,
    input: Record<string, unknown>,
    options?: { idempotencyKey?: string; version?: number },
  ): Promise<CommandResult> {
    const startTime = Date.now();
    const definition = this.registry.resolve(commandIdOrAlias, options?.version);
    const idempotencyKey = options?.idempotencyKey ?? (input.idempotencyKey as string) ?? `ik_cmd_${randomUUID()}`;
    const requestFingerprint = commandRequestFingerprint(definition.id, definition.version, input);

    // 1. Idempotency Check
    const existing = await this.invocationRepo.getByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.commandId !== definition.id || existing.commandVersion !== definition.version || existing.requestFingerprint !== requestFingerprint) {
        return this.failedResult(existing, "COMMAND_IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to an incompatible command request", startTime);
      }
      if (["failed", "cancelled", "completed", "running", "verifying", "accepted", "pending"].includes(existing.status)) {
        return {
          invocationId: existing.invocationId,
          commandId: existing.commandId,
          commandVersion: existing.commandVersion,
          taskRunId: existing.taskRunId,
          status: existing.status,
          summary: `Idempotent invocation retrieved (${existing.status})`,
          timestamps: {
            startedAt: existing.createdAt,
            completedAt: existing.completedAt ?? new Date().toISOString(),
            durationMs: Date.now() - startTime,
          },
        };
      }
    }

    const invocationId = `inv_${randomUUID()}`;
    const invocation: CommandInvocation = {
      invocationId,
      commandId: definition.id,
      commandVersion: definition.version,
      idempotencyKey,
      status: "pending",
      input,
      requestFingerprint,
      retryCount: 0,
      createdAt: new Date(startTime).toISOString(),
      updatedAt: new Date(startTime).toISOString(),
    };

    // 2. Persist Pending Invocation (R1 boundary)
    try {
      await this.invocationRepo.saveInvocation(invocation);
    } catch (e: any) {
      if (e.message === 'CONCURRENCY_CONFLICT') {
        const raceExisting = await this.invocationRepo.getByIdempotencyKey(idempotencyKey);
        if (raceExisting) {
          if (raceExisting.commandId !== definition.id || raceExisting.commandVersion !== definition.version || raceExisting.requestFingerprint !== requestFingerprint) {
            return this.failedResult(raceExisting, "COMMAND_IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to an incompatible command request", startTime);
          }
          return {
            invocationId: raceExisting.invocationId,
            commandId: raceExisting.commandId,
            commandVersion: raceExisting.commandVersion,
            taskRunId: raceExisting.taskRunId,
            status: raceExisting.status,
            summary: `Idempotent invocation retrieved (${raceExisting.status})`,
            timestamps: {
              startedAt: raceExisting.createdAt,
              completedAt: raceExisting.completedAt ?? new Date().toISOString(),
              durationMs: Date.now() - startTime,
            },
          };
        }
      }
      if (e instanceof CommandIdempotencyConflictError) {
        return this.failedResult(invocation, "COMMAND_IDEMPOTENCY_CONFLICT", e.message, startTime);
      }
      throw e;
    }

    try {
      // 3. Compile Executable Plan
      const { plan: compiledPlan } = await this.compiler.compile(definition.id, definition.version, invocationId, input);
      let plan = compiledPlan;
      const runService = this.runtime.services.runService;
      if (!input.taskRunId && runService?.createRun) {
        const run = await runService.createRun({ runType: plan.strategy, contractId: plan.contractId, correlationId: invocationId, metadata: { commandId: definition.id, commandVersion: definition.version, invocationId } }, invocationId);
        plan = { ...plan, taskRunId: run.id };
      }

      invocation.status = "running";
      invocation.taskRunId = plan.taskRunId;
      invocation.contractId = plan.contractId;
      const canonicalPlan = this.persistCanonicalPlan(plan, input);
      invocation.planId = canonicalPlan.planId;
      await this.invocationRepo.saveInvocation(invocation);

      const assignmentIds = await this.runtime.assignmentBindingCoordinator.ensureAssignments(canonicalPlan, invocationId);

      return await this.continueExecution(invocation, definition, canonicalPlan, assignmentIds, startTime, false);
    } catch (error: any) {
      if (invocation.status === "cancelled") return this.failedResult(invocation, "COMMAND_CANCELLED", invocation.error?.message ?? "Command cancelled", startTime, "cancelled");
      const failedAt = new Date().toISOString();
      invocation.status = "failed";
      invocation.completedAt = failedAt;
      invocation.error = {
        code: error.code ?? "COMMAND_EXECUTION_ERROR",
        message: error.message ?? String(error),
      };
      await this.invocationRepo.saveInvocation(invocation);

      return {
        invocationId,
        commandId: definition.id,
        commandVersion: definition.version,
        status: "failed",
        summary: `Command ${definition.id} failed: ${invocation.error.message}`,
        error: invocation.error,
        timestamps: {
          startedAt: invocation.createdAt,
          completedAt: failedAt,
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Shared continuation used by both fresh execution and fresh-runtime
   * recovery. It is idempotent with respect to durable state:
   *  - already-succeeded workstreams are not re-dispatched (canonical scheduler
   *    only runs workstreams still in ready/planned state);
   *  - an existing durable VerificationResult is reused when current;
   *  - an existing durable CompletionDecision is reused (no second logical
   *    completion decision);
   *  - a terminal CommandResult is never re-entered.
   */
  private async continueExecution(
    invocation: CommandInvocation,
    definition: CommandDefinition,
    canonicalPlan: ExecutionPlan,
    assignmentIds: Map<string, string>,
    startTime: number,
    _recovery: boolean,
  ): Promise<CommandResult> {
    const sourceSha = String(invocation.input.sourceSha ?? "");
    const scheduler = this.runtime.executionScheduler;
    if (!scheduler?.runReady && !this.runtime.worktreeExecutionService) throw new CommandRecoveryError("CANONICAL_SCHEDULER_UNAVAILABLE", "Canonical scheduler unavailable");

    const dispatch = {
      execute: async (workstream: any, _allocation?: any, budget?: any, context?: unknown) => {
        const assignmentId = assignmentIds.get(workstream.workstreamId);
        if (assignmentId) {
          this.runtime.assignmentBindingCoordinator.recordAttempt(assignmentId);
          if (assignmentId && this.runtime.services.assignmentService?.assignAssignment) await this.runtime.services.assignmentService.assignAssignment(assignmentId);
          if (assignmentId && this.runtime.services.assignmentService?.startAssignment) await this.runtime.services.assignmentService.startAssignment(assignmentId);
        }
        try {
          let agentResult: { status: string; verificationPassed?: boolean; integrationPassed?: boolean; durationMs?: number } | null = null;
          if (budget || this.runtime.worktreeExecutionService) {
            if (!this.runtime.agentExecutor) throw new CommandRecoveryError("CANONICAL_AGENT_EXECUTOR_UNAVAILABLE", "Canonical agent executor unavailable");
            const result = await this.runtime.agentExecutor.execute(workstream, _allocation, budget ?? undefined, context as any);
            if (result && typeof result === "object" && "status" in result) {
              agentResult = result as any;
            }
            // The agent's verification verdict is authoritative: a succeeded
            // workstream that reports verification-failed must not reach the
            // integration gate (VERIFICATION_REQUIRED_BEFORE_INTEGRATION).
            if (agentResult && (agentResult.status !== "succeeded" || agentResult.verificationPassed === false)) {
              throw new Error("CANONICAL_AGENT_EXECUTION_FAILED");
            }
          }
          if (assignmentId) {
            this.runtime.assignmentBindingCoordinator.markSucceeded(assignmentId);
            if (this.runtime.services.assignmentService?.completeAssignment) await this.runtime.services.assignmentService.completeAssignment(assignmentId);
          }
          return this.runtime.worktreeExecutionService
            ? { status: "succeeded" as const, verificationPassed: agentResult?.verificationPassed ?? true, integrationPassed: agentResult?.integrationPassed ?? false, durationMs: agentResult?.durationMs ?? 0 }
            : "succeeded" as const;
        } catch (error) {
          if (assignmentId) {
            this.runtime.assignmentBindingCoordinator.markFailed(assignmentId);
            if (this.runtime.services.assignmentService?.failAssignment) await this.runtime.services.assignmentService.failAssignment(assignmentId);
          }
          return "failed" as const;
        }
      },
    };

    const scheduleResult = this.runtime.worktreeExecutionService
      ? await this.runtime.worktreeExecutionService.executePlan(canonicalPlan.planId, canonicalPlan.sourceSha, dispatch as any)
      : await (scheduler as any).runReady(canonicalPlan.planId, dispatch as any);

    const durableAfterSchedule = await this.invocationRepo.getByInvocationId(invocation.invocationId);
    if (durableAfterSchedule?.status === "cancelled") {
      invocation.status = "cancelled";
      invocation.error = durableAfterSchedule.error;
      throw new CommandRecoveryError("COMMAND_CANCELLED", invocation.error?.message ?? "Command cancelled");
    }
    if (scheduleResult.failed.length > 0 || scheduleResult.blocked.length > 0) throw new CommandRecoveryError("CANONICAL_SCHEDULER_FAILED", "Canonical scheduler reported failed/blocked workstreams");
    const executionRepository = this.runtime.executionRepository;

    // Fault-injection seam: simulate a crash after dispatch but before
    // verification/completion. Dependency-injected; never persisted.
    this.runtime.faultHook?.afterDispatch?.(invocation.invocationId);

    // 4. Verification (idempotent — reuse durable result when current)
    let verificationPassed = false;
    if (definition.verificationPolicy.requiresPassedVerification) {
      invocation.status = "verifying";
      await this.invocationRepo.saveInvocation(invocation);
      const verifier = this.runtime.commandVerification;
      if (!verifier) throw new CommandRecoveryError("CANONICAL_VERIFIER_UNAVAILABLE", "Canonical verifier unavailable");
      const existingResult = this.loadExistingVerification(canonicalPlan.runId);
      const existingPassDecision = this.loadPassCompletionDecision(canonicalPlan.runId, sourceSha);
      let verificationResults: readonly unknown[] = [];
      let evidenceItems: readonly unknown[] = [];
      if (existingResult && existingResult.status === "passed" && existingPassDecision) {
        verificationPassed = true;
      } else {
        const verification = await verifier.verifyCommand({ runId: canonicalPlan.runId, commandId: definition.id, commandVersion: definition.version, sourceSha, invocationId: invocation.invocationId });
        verificationPassed = verification.passed;
        if (!verificationPassed) throw new CommandRecoveryError("CANONICAL_VERIFICATION_FAILED", "Canonical verification failed");
        verificationResults = verification.verificationResults;
        evidenceItems = verification.evidenceItems;
      }

      const completion = this.runtime.commandCompletion;
      if (!completion) throw new CommandRecoveryError("CANONICAL_COMPLETION_UNAVAILABLE", "Canonical completion unavailable");
      this.runtime.faultHook?.beforeCompletion?.(invocation.invocationId);
      const decision = await this.reuseOrEvaluateCompletion(completion, {
        runId: canonicalPlan.runId,
        commandId: definition.id,
        commandVersion: definition.version,
        sourceSha,
        invocationId: invocation.invocationId,
        verificationResults,
        evidenceItems,
        verificationRequired: true,
      });
      if (decision.outcome !== "completed") throw new CommandRecoveryError("CANONICAL_COMPLETION_BLOCKED", `Canonical completion blocked:${decision.decisionId}`, { decisionId: decision.decisionId });
    }

    // 5. Completion Engine Integration (idempotent)
    if (!definition.verificationPolicy.requiresPassedVerification) {
      const completion = this.runtime.commandCompletion;
      if (!completion) throw new CommandRecoveryError("CANONICAL_COMPLETION_UNAVAILABLE", "Canonical completion unavailable");
      this.runtime.faultHook?.beforeCompletion?.(invocation.invocationId);
      const decision = await this.reuseOrEvaluateCompletion(completion, {
        runId: canonicalPlan.runId,
        commandId: definition.id,
        commandVersion: definition.version,
        sourceSha,
        invocationId: invocation.invocationId,
        verificationResults: [],
        evidenceItems: [],
        verificationRequired: false,
      });
      if (decision.outcome !== "completed") throw new CommandRecoveryError("CANONICAL_COMPLETION_BLOCKED", `Canonical completion blocked:${decision.decisionId}`, { decisionId: decision.decisionId });
    }

    // Plan reaches "succeeded" only when the command actually completes;
    // a verification/completion failure leaves it non-succeeded.
    if (executionRepository.transitionPlanStatus && executionRepository.getPlan?.(canonicalPlan.planId)?.status !== "succeeded") executionRepository.transitionPlanStatus(canonicalPlan.planId, "succeeded");

    const completedAt = new Date().toISOString();
    invocation.status = "completed";
    invocation.completedAt = completedAt;
    await this.invocationRepo.saveInvocation(invocation);

    return {
      invocationId: invocation.invocationId,
      commandId: definition.id,
      commandVersion: definition.version,
      taskRunId: canonicalPlan.runId,
      status: "completed",
      summary: `Command ${definition.id} v${definition.version} executed successfully`,
      verificationPassed,
      timestamps: {
        startedAt: invocation.createdAt,
        completedAt,
        durationMs: Date.now() - startTime,
      },
    };
  }

  async cancelCommand(invocationId: string, reason = "cancelled by caller"): Promise<CommandResult> {
    const invocation = await this.invocationRepo.getByInvocationId(invocationId);
    if (!invocation) throw new CommandRecoveryError("COMMAND_INVOCATION_NOT_FOUND", "Command invocation not found");
    if (["completed", "failed", "cancelled"].includes(invocation.status)) return this.failedResult(invocation, "COMMAND_ALREADY_TERMINAL", `Command is already ${invocation.status}`, Date.now());
    const runService = this.runtime.services.runService;
    if (invocation.taskRunId && !runService?.cancelRun) throw new CommandRecoveryError("CANONICAL_CANCELLATION_UNAVAILABLE", "Canonical cancellation unavailable");
    if (invocation.taskRunId) await runService.cancelRun(invocation.taskRunId, reason);
    if (invocation.planId && this.runtime.executionRepository?.cancelPlan) {
      this.runtime.executionRepository.cancelPlan(invocation.planId, reason);
    }
    for (const binding of this.runtime.assignmentBindingCoordinator.listByPlan(invocation.planId ?? "")) {
      this.runtime.assignmentBindingCoordinator.markCancelled(binding.assignmentId);
    }
    invocation.status = "cancelled";
    invocation.error = { code: "COMMAND_CANCELLED", message: reason };
    invocation.completedAt = new Date().toISOString();
    await this.invocationRepo.saveInvocation(invocation);
    return this.failedResult(invocation, "COMMAND_CANCELLED", reason, Date.now(), "cancelled");
  }

  /**
   * Fresh-runtime durable recovery. Reconstructs authoritative state from
   * durable storage, validates graph consistency, derives the first incomplete
   * canonical phase, reconciles live resources, and continues from there. It
   * does NOT blindly replay the command from the beginning and does NOT rely
   * solely on CommandInvocation.state.
   */
  async recoverCommand(invocationId: string): Promise<CommandResult> {
    const startTime = Date.now();
    const invocation = await this.invocationRepo.getByInvocationId(invocationId);
    if (!invocation) throw new CommandRecoveryError("COMMAND_INVOCATION_NOT_FOUND", "Command invocation not found");

    // Terminal state: return immediately without re-entering execution.
    if (["completed", "failed", "cancelled"].includes(invocation.status)) {
      return this.projectTerminal(invocation, startTime);
    }

    // Single-flight recovery claim: a second concurrent recoverer converges on
    // the durable terminal result rather than dispatching a second time.
    if (!this.runtime.recoveryClaim.acquire(invocationId)) {
      return this.awaitConcurrentRecovery(invocation, startTime);
    }

    try {
      // Resolve the EXACT persisted command version. Never "latest".
      let definition: CommandDefinition;
      try {
        definition = this.registry.resolve(invocation.commandId, invocation.commandVersion);
      } catch {
        throw new CommandRecoveryError("COMMAND_HISTORICAL_VERSION_UNRESOLVABLE", `Historical command version ${invocation.commandVersion} for ${invocation.commandId} is not registered`);
      }

      // Load durable runtime graph.
      const runRepo = this.runtime.services.runRepo;
      const run = invocation.taskRunId && runRepo ? await runRepo.findById(invocation.taskRunId) : null;
      const plan = invocation.planId ? this.runtime.executionRepository.getPlan(invocation.planId) : null;

      // Validate graph consistency; fail closed on contradiction.
      this.validateGraph(invocation, run, plan);

      // Derive resume point and continue. If the plan already exists, load it
      // rather than recompiling. If it is absent, compile/persist exactly once.
      let canonicalPlan = plan;
      if (!canonicalPlan) {
        if (!invocation.taskRunId || !run) throw new CommandRecoveryError("CANONICAL_RECOVERY_STATE_MISSING", "Invocation references no durable Run");
        const { plan: compiledPlan } = await this.compiler.compile(definition.id, definition.version, invocationId, invocation.input);
        canonicalPlan = this.persistCanonicalPlan({ ...compiledPlan, taskRunId: invocation.taskRunId }, invocation.input);
        invocation.planId = canonicalPlan.planId;
        await this.invocationRepo.saveInvocation(invocation);
      }

      // Reconcile the logical Assignment graph (load existing, do not recreate).
      const assignmentIds = await this.runtime.assignmentBindingCoordinator.ensureAssignments(canonicalPlan, invocationId);

      invocation.status = "running";
      await this.invocationRepo.saveInvocation(invocation);

      return await this.continueExecution(invocation, definition, canonicalPlan, assignmentIds, startTime, true);
    } catch (error: any) {
      if (error instanceof CommandRecoveryError) throw error;
      if (invocation.status === "cancelled") return this.failedResult(invocation, "COMMAND_CANCELLED", invocation.error?.message ?? "Command cancelled", startTime, "cancelled");
      const failedAt = new Date().toISOString();
      invocation.status = "failed";
      invocation.completedAt = failedAt;
      invocation.error = { code: error.code ?? "COMMAND_EXECUTION_ERROR", message: error.message ?? String(error) };
      await this.invocationRepo.saveInvocation(invocation);
      return {
        invocationId,
        commandId: invocation.commandId,
        commandVersion: invocation.commandVersion,
        status: "failed",
        summary: `Command ${invocation.commandId} recovery failed: ${invocation.error.message}`,
        error: invocation.error,
        timestamps: { startedAt: invocation.createdAt, completedAt: failedAt, durationMs: Date.now() - startTime },
      };
    } finally {
      this.runtime.recoveryClaim.release(invocationId);
    }
  }

  private validateGraph(
    invocation: CommandInvocation,
    run: { id: string } | null,
    plan: ExecutionPlan | null,
  ): void {
    if (invocation.taskRunId && run && run.id !== invocation.taskRunId) {
      throw new CommandRecoveryError("COMMAND_RECOVERY_GRAPH_CONTRADICTION", "Invocation Run reference contradicts durable Run");
    }
    if (invocation.planId && plan && plan.runId !== invocation.taskRunId) {
      throw new CommandRecoveryError("COMMAND_RECOVERY_GRAPH_CONTRADICTION", "Invocation plan references a Run unrelated to the invocation Run");
    }
    if (plan && invocation.planId && plan.planId !== invocation.planId) {
      throw new CommandRecoveryError("COMMAND_RECOVERY_GRAPH_CONTRADICTION", "Invocation plan id contradicts durable plan id");
    }
  }

  private async awaitConcurrentRecovery(invocation: CommandInvocation, startTime: number): Promise<CommandResult> {
    // Bounded poll: the winning recoverer will drive the invocation to a
    // terminal state; we converge on that durable result.
    for (let i = 0; i < 50; i++) {
      const current = await this.invocationRepo.getByInvocationId(invocation.invocationId);
      if (current && ["completed", "failed", "cancelled"].includes(current.status)) {
        return this.projectTerminal(current, startTime);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    // If the winner has not finished, fall back to a direct terminal projection
    // only when the durable state is already terminal; otherwise report the
    // current non-terminal state without re-dispatching.
    const current = await this.invocationRepo.getByInvocationId(invocation.invocationId);
    if (current && ["completed", "failed", "cancelled"].includes(current.status)) return this.projectTerminal(current, startTime);
    return {
      invocationId: invocation.invocationId,
      commandId: invocation.commandId,
      commandVersion: invocation.commandVersion,
      taskRunId: invocation.taskRunId,
      status: current?.status ?? invocation.status,
      summary: "Recovery deferred to concurrent recoverer",
      timestamps: { startedAt: invocation.createdAt, completedAt: new Date().toISOString(), durationMs: Date.now() - startTime },
    };
  }

  private projectTerminal(invocation: CommandInvocation, startTime: number): CommandResult {
    return {
      invocationId: invocation.invocationId,
      commandId: invocation.commandId,
      commandVersion: invocation.commandVersion,
      taskRunId: invocation.taskRunId,
      status: invocation.status as CommandInvocation["status"],
      summary: `Command is already ${invocation.status}`,
      error: invocation.error,
      timestamps: {
        startedAt: invocation.createdAt,
        completedAt: invocation.completedAt ?? invocation.updatedAt,
        durationMs: Date.now() - startTime,
      },
    };
  }

  private loadExistingVerification(runId: string): { status: string } | null {
    const db = this.runtime.executionRepository.getDb();
    const row = db.query("SELECT status FROM verification_results WHERE run_id = ? AND verification_type = 'result' ORDER BY started_at DESC LIMIT 1").get(runId) as { status: string } | null;
    return row ? { status: row.status } : null;
  }

  private loadPassCompletionDecision(runId: string, sourceSha: string): boolean {
    const db = this.runtime.executionRepository.getDb();
    const sha = /^[0-9a-f]{40}$/.test(sourceSha) ? sourceSha : "0".repeat(40);
    const row = db.query("SELECT id FROM completion_decisions WHERE run_id = ? AND decision = 'pass' AND sha = ? ORDER BY decided_at DESC LIMIT 1").get(runId, sha);
    return row !== null;
  }

  private async reuseOrEvaluateCompletion(
    completion: NonNullable<CommandExecutorRuntimeDeps["commandCompletion"]>,
    input: { runId: string; commandId: string; commandVersion: number; sourceSha: string; invocationId: string; verificationResults: readonly unknown[]; evidenceItems: readonly unknown[]; verificationRequired: boolean },
  ): Promise<{ outcome: string; decisionId: string }> {
    const db = this.runtime.executionRepository.getDb();
    const sha = /^[0-9a-f]{40}$/.test(input.sourceSha) ? input.sourceSha : "0".repeat(40);
    const existing = db.query("SELECT id, decision, sha FROM completion_decisions WHERE run_id = ? AND decision = 'pass' AND sha = ? ORDER BY decided_at DESC LIMIT 1").get(input.runId, sha) as { id: string; decision: string; sha: string } | null;
    if (existing && existing.decision === "pass") {
      return { outcome: "completed", decisionId: existing.id };
    }
    return completion.evaluateCommand(input);
  }

  private persistCanonicalPlan(plan: ExecutableCommandPlan, input: Record<string, unknown>): ExecutionPlan {
    const sourceSha = typeof input.sourceSha === "string" && /^[0-9a-f]{40}$/.test(input.sourceSha) ? input.sourceSha : "0".repeat(40);
    const canonical: ExecutionPlan = {
      planId: `plan:${plan.invocationId}`,
      runId: plan.taskRunId,
      routingDecisionId: `command:${plan.commandId}:${plan.commandVersion}`,
      sourceSha,
      policyVersion: `command-${plan.commandId}-v${plan.commandVersion}`,
      createdAt: new Date().toISOString(),
      status: "planned",
      workstreams: plan.workstreams.map(workstream => ({
        workstreamId: workstream.id,
        runId: plan.taskRunId,
        planId: `plan:${plan.invocationId}`,
        resolvedAgent: workstream.agentRole,
        requiredCapability: workstream.agentRole,
        objective: workstream.name,
        requirements: [],
        acceptanceCriteria: [],
        ownedPaths: Array.isArray(input.ownedPaths) ? input.ownedPaths.filter((path): path is string => typeof path === "string") : [],
        ownedSymbols: [],
        dependsOn: workstream.dependencies,
        strategy: plan.strategy,
        budgetProfile: "normal",
        contextScope: "owned",
        status: "planned",
        blockedBy: [],
        createdAt: new Date().toISOString(),
      })),
    };
    const repository = this.runtime.executionRepository;
    if (!repository?.savePlan) throw new CommandRecoveryError("CANONICAL_EXECUTION_REPOSITORY_UNAVAILABLE", "Canonical execution repository unavailable");
    return repository.savePlan(canonical);
  }

  private failedResult(invocation: CommandInvocation, code: string, message: string, startTime: number, projectedStatus: CommandInvocation["status"] = "failed"): CommandResult {
    return {
      invocationId: invocation.invocationId,
      commandId: invocation.commandId,
      commandVersion: invocation.commandVersion,
      taskRunId: invocation.taskRunId,
      status: projectedStatus,
      summary: message,
      error: { code, message },
      timestamps: {
        startedAt: invocation.createdAt,
        completedAt: invocation.completedAt ?? new Date().toISOString(),
        durationMs: Date.now() - startTime,
      },
    };
  }
}
