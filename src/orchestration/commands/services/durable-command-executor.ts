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
import { randomUUID } from "crypto";

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

export class DurableCommandExecutor {
  private readonly compiler: CommandCompiler;

  constructor(
    private readonly registry: CommandRegistry,
    private readonly invocationRepo: SqliteCommandInvocationRepository,
    private readonly runtime: Pick<ProductionOrchestrationRuntime, "services" | "executionRepository" | "executionScheduler"> & {
      worktreeExecutionService?: { executePlan(planId: string, sourceSha: string, executor: { execute(workstream: unknown, allocation: unknown, budget?: unknown, context?: unknown): Promise<"succeeded" | "failed"> }): Promise<{ succeeded: string[]; failed: string[]; blocked: string[] }> }
      commandVerification?: { verifyCommand(input: { runId: string; commandId: string; commandVersion: number; sourceSha: string; invocationId: string }): Promise<{ passed: boolean; verificationResults: readonly unknown[]; evidenceItems: readonly unknown[] }> }
      commandCompletion?: { evaluateCommand(input: { runId: string; commandId: string; commandVersion: number; sourceSha: string; invocationId: string; verificationResults: readonly unknown[]; evidenceItems: readonly unknown[] }): Promise<{ outcome: string; decisionId: string }> }
    },
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
      if (existing.status === "failed" || existing.status === "cancelled" || existing.status === "completed" || existing.status === "running" || existing.status === "verifying" || existing.status === "accepted" || existing.status === "pending") {
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

    // 2. Persist Pending Invocation
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
      const runService = (this.runtime.services as any)?.runService;
      if (!input.taskRunId && runService?.createRun) {
        const run = await runService.createRun({ runType: plan.strategy, contractId: plan.contractId, metadata: { commandId: definition.id, commandVersion: definition.version, invocationId } }, invocationId);
        plan = { ...plan, taskRunId: run.id };
      }

      invocation.status = "running";
      invocation.taskRunId = plan.taskRunId;
      invocation.contractId = plan.contractId;
      const canonicalPlan = this.persistCanonicalPlan(plan, input);
      invocation.planId = canonicalPlan.planId;
      await this.invocationRepo.saveInvocation(invocation);
      const scheduler = this.runtime.executionScheduler as any;
      if (!scheduler?.runReady && !this.runtime.worktreeExecutionService) throw new Error("CANONICAL_SCHEDULER_UNAVAILABLE");
      const scheduleResult = this.runtime.worktreeExecutionService
        ? await this.runtime.worktreeExecutionService.executePlan(canonicalPlan.planId, canonicalPlan.sourceSha, { execute: async () => "succeeded" })
        : await scheduler.runReady(canonicalPlan.planId, { execute: async () => "succeeded" });
      const durableAfterSchedule = await this.invocationRepo.getByInvocationId(invocationId);
      if (durableAfterSchedule?.status === "cancelled") {
        invocation.status = "cancelled";
        invocation.error = durableAfterSchedule.error;
        throw new Error("COMMAND_CANCELLED");
      }
      if (scheduleResult.failed.length > 0 || scheduleResult.blocked.length > 0) throw new Error("CANONICAL_SCHEDULER_FAILED");
      const executionRepository = this.runtime.executionRepository as any;
      if (executionRepository.transitionPlanStatus) executionRepository.transitionPlanStatus(canonicalPlan.planId, "succeeded");

      // 4. Verification Check Integration
      let verificationPassed = false;
      if (definition.verificationPolicy.requiresPassedVerification) {
        invocation.status = "verifying";
        await this.invocationRepo.saveInvocation(invocation);
        const verifier = this.runtime.commandVerification;
        if (!verifier) throw new Error("CANONICAL_VERIFIER_UNAVAILABLE");
        const verification = await verifier.verifyCommand({ runId: plan.taskRunId, commandId: definition.id, commandVersion: definition.version, sourceSha: String(input.sourceSha ?? ""), invocationId });
        verificationPassed = verification.passed;
        if (!verificationPassed) throw new Error("CANONICAL_VERIFICATION_FAILED");

        const completion = this.runtime.commandCompletion;
        if (!completion) throw new Error("CANONICAL_COMPLETION_UNAVAILABLE");
        const decision = await completion.evaluateCommand({ runId: plan.taskRunId, commandId: definition.id, commandVersion: definition.version, sourceSha: String(input.sourceSha ?? ""), invocationId, verificationResults: verification.verificationResults, evidenceItems: verification.evidenceItems });
        if (decision.outcome !== "completed") throw new Error(`CANONICAL_COMPLETION_BLOCKED:${decision.decisionId}`);
      }

      // 5. Completion Engine Integration
      if (!definition.verificationPolicy.requiresPassedVerification) {
        const completion = this.runtime.commandCompletion;
        if (!completion) throw new Error("CANONICAL_COMPLETION_UNAVAILABLE");
        const decision = await completion.evaluateCommand({ runId: plan.taskRunId, commandId: definition.id, commandVersion: definition.version, sourceSha: String(input.sourceSha ?? ""), invocationId, verificationResults: [], evidenceItems: [] });
        if (decision.outcome !== "completed") throw new Error(`CANONICAL_COMPLETION_BLOCKED:${decision.decisionId}`);
      }
      const completedAt = new Date().toISOString();
      invocation.status = "completed";
      invocation.completedAt = completedAt;
      await this.invocationRepo.saveInvocation(invocation);

      return {
        invocationId,
        commandId: definition.id,
        commandVersion: definition.version,
        taskRunId: plan.taskRunId,
        status: "completed",
        summary: `Command ${definition.id} v${definition.version} executed successfully`,
        verificationPassed,
        timestamps: {
          startedAt: invocation.createdAt,
          completedAt,
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      if (invocation.status === "cancelled") return this.failedResult(invocation, "COMMAND_CANCELLED", invocation.error?.message ?? "Command cancelled", startTime, "cancelled")
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

  async cancelCommand(invocationId: string, reason = "cancelled by caller"): Promise<CommandResult> {
    const invocation = await this.invocationRepo.getByInvocationId(invocationId)
    if (!invocation) throw new Error("COMMAND_INVOCATION_NOT_FOUND")
    if (["completed", "failed", "cancelled"].includes(invocation.status)) return this.failedResult(invocation, "COMMAND_ALREADY_TERMINAL", `Command is already ${invocation.status}`, Date.now())
    const runService = (this.runtime.services as any)?.runService
    if (invocation.taskRunId && !runService?.cancelRun) throw new Error("CANONICAL_CANCELLATION_UNAVAILABLE")
    if (invocation.taskRunId) await runService.cancelRun(invocation.taskRunId, reason)
    if (invocation.planId && (this.runtime.executionRepository as any)?.cancelPlan) {
      ;(this.runtime.executionRepository as any).cancelPlan(invocation.planId, reason)
    }
    invocation.status = "cancelled"
    invocation.error = { code: "COMMAND_CANCELLED", message: reason }
    invocation.completedAt = new Date().toISOString()
    await this.invocationRepo.saveInvocation(invocation)
    return this.failedResult(invocation, "COMMAND_CANCELLED", reason, Date.now(), "cancelled")
  }

  async recoverCommand(invocationId: string): Promise<CommandResult> {
    const invocation = await this.invocationRepo.getByInvocationId(invocationId)
    if (!invocation) throw new Error("COMMAND_INVOCATION_NOT_FOUND")
    if (invocation.status === "completed" || invocation.status === "cancelled" || invocation.status === "failed") {
      return this.failedResult(invocation, "COMMAND_TERMINAL", `Command is already ${invocation.status}`, Date.now())
    }
    const repository = this.runtime.executionRepository as any
    if (repository?.recoverAfterRestart) repository.recoverAfterRestart()
    if (!invocation.planId || !repository?.getPlan || !repository.getPlan(invocation.planId)) throw new Error("CANONICAL_RECOVERY_STATE_MISSING")
    return {
      invocationId: invocation.invocationId, commandId: invocation.commandId, commandVersion: invocation.commandVersion,
      taskRunId: invocation.taskRunId, status: invocation.status, summary: "Recovered canonical command state",
      timestamps: { startedAt: invocation.createdAt, completedAt: invocation.updatedAt, durationMs: Date.now() - Date.parse(invocation.createdAt) },
    }
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
        ownedPaths: [],
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
    const repository = this.runtime.executionRepository as any;
    if (!repository?.savePlan) throw new Error("CANONICAL_EXECUTION_REPOSITORY_UNAVAILABLE");
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
