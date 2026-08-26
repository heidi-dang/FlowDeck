import { randomUUID } from "node:crypto";
import type { ProductionOrchestrationRuntime } from "../orchestration/composition";
import {
  setRouteDecision,
  clearRouteDecision,
  noteInternalContinuation,
  getRouteDecision,
  isDuplicateMessage,
  markRouteInactive,
} from "../services/heidi-route-state";
import { classifyTask, executionModeForClass, type RouterDecision, stableHash } from "../services/heidi-fast-router";
import type { Event, UserMessage, Part, TextPart } from "@opencode-ai/sdk";
import { isTerminalRunStatus, OrchestrationPhase as OP, type Run } from "../orchestration/types/runs";
import type { DeferredReplacementRecord } from "../orchestration/persistence/repositories/deferred-replacement";
import { ErrorCodes } from "../orchestration/types/errors";
import {
  buildCanonicalRoutingDecision,
  reconstructRouterDecision,
  mapExecutionClassToRunStrategy,
  specialistPlanFromRoutingDecision,
  repoMasterAdviceFromRoutingDecision,
} from "../orchestration/routing/fast-router-adapter";
import { classifyUserTurnIntent } from "../services/user-turn-intent";
import { normalizeTaskInvocation } from "../services/task-invocation-adapter";

export interface PendingFastDirectTurn {
  sessionID: string;
  taskId: string;
  messageHash: string;
  messageID?: string;
  turnVersion: number;
}

import {
  extractMutationTargets,
  getMutationTargetFingerprint,
} from "./mutation-observation-adapter";
import type { NativeChildControlPort } from "../orchestration/services/child-execution-lifecycle-service";
import type { InternalMessageProvenance } from "../orchestration/persistence/repositories/internal-message-provenance";
import { ContinuationDispatcher, type ContinuationToken, getContinuationPrompt } from "../orchestration/services/continuation-policy";
import { readySpecialistSpecs } from "../orchestration/routing/specialist-planner";
import { repoMasterConsultationRequirement, type RepoMasterAdvice } from "../orchestration/repository/repo-master";
import { createOpenCodeMessageId } from "./opencode-identifier";

function specialistIdFromNativeTask(prompt?: string, description?: string): string | undefined {
  const match = `${description ?? ""}\n${prompt ?? ""}`.match(/\[FlowDeck specialist:([A-Za-z0-9-]+)\]/);
  return match?.[1];
}

export class FlowDeckLifecycleAdapter implements NativeChildControlPort {
  private disposed = false;
  private turnVersionCounter = 0;
  private pendingFastDirectTurns = new Map<string, PendingFastDirectTurn>();
  private preToolRepositoryFingerprints = new Map<string, string>();
  private inFlightAttempts = new Map<string, { runId: string; assignmentId: string; attemptNumber: number; preStateFingerprint: string; actionFingerprint: string; startedAt: string }>();
  private continuationDispatcher: ContinuationDispatcher;
  private startupReadyPromise: Promise<number | void> | null = null;
  /** Deferred recovery work must complete before terminal persistence shutdown. */
  private readonly lifecycleTasks = new Set<Promise<unknown>>();
  /** Event-driven ledger maintenance state; no background timer is used. */
  private lastInternalMessagePruneAt = 0;
  private lastInternalMessagePruneCount = 0;
  public testHandoffFaultHook?: (type: "FAST_DIRECT" | "ORCHESTRATED", deferred: DeferredReplacementRecord, replacement?: Run) => Promise<void> | void;

  constructor(
    private readonly directory: string,
    private readonly runtime: ProductionOrchestrationRuntime,
    private client?: any,
  ) {
    this.continuationDispatcher = new ContinuationDispatcher(this.runtime.db);
    this.runtime.childExecutionLifecycleService?.setControlPort(this);
    if (this.client) {
      this.startupReadyPromise = this.trackLifecycleTask(this.drainSafeDeferredReplacements()).catch(err => {
        console.warn("[FlowDeckLifecycleAdapter] drainSafeDeferredReplacements on startup threw:", err);
      });
    }
  }

  get startupReady(): Promise<number | void> {
    return this.startupReadyPromise ?? Promise.resolve();
  }

  async initialize(client?: any): Promise<void> {
    if (client) {
      this.client = client;
    }
    if (!this.startupReadyPromise) {
      this.startupReadyPromise = this.trackLifecycleTask(this.drainSafeDeferredReplacements()).catch(err => {
        console.warn("[FlowDeckLifecycleAdapter] drainSafeDeferredReplacements on initialize threw:", err);
      });
    }
    await this.startupReadyPromise;
  }

  getClient(): any {
    return this.client;
  }

  private trackLifecycleTask<T>(task: Promise<T>): Promise<T> {
    let tracked: Promise<T>;
    tracked = task.finally(() => this.lifecycleTasks.delete(tracked));
    this.lifecycleTasks.add(tracked);
    return tracked;
  }

  private async awaitLifecycleQuiescence(): Promise<void> {
    while (this.lifecycleTasks.size > 0) {
      await Promise.allSettled(this.lifecycleTasks);
    }
  }

  setClient(client: any): void {
    if (client) {
      this.client = client;
      // Trigger drain of any safe deferred replacements waiting on native prompt dispatch
      this.startupReadyPromise = this.trackLifecycleTask(this.drainSafeDeferredReplacements()).catch(err => {
        console.warn("[FlowDeckLifecycleAdapter] drainSafeDeferredReplacements on setClient threw:", err);
      });
    }
  }

  async abortSession(sessionId: string, directory?: string): Promise<{ aborted: boolean; error?: string }> {
    if (!this.client?.session?.abort) {
      return { aborted: false, error: "Native client session.abort not available" };
    }
    try {
      const res = await this.client.session.abort({
        path: { id: sessionId },
        query: directory ? { directory } : undefined,
      });
      if (res === true || res?.data === true || (res && !res.error)) {
        return { aborted: true };
      }
      return { aborted: false, error: res?.error ? String(res.error) : "Abort rejected" };
    } catch (err: any) {
      return { aborted: false, error: err?.message ?? String(err) };
    }
  }

  getUserTurnVersion(sessionId: string): number {
    return this.runtime.sessionTurnRepo.getTurnVersion(sessionId);
  }

  private reserveInternalPrompt(input: {
    sessionId: string;
    messageId: string;
    provenance: InternalMessageProvenance;
    dispatchIdentity: string;
  }): boolean {
    return this.runtime.internalMessageProvenanceRepo.reserve(input);
  }

  private newInternalPromptMessageId(): string {
    return createOpenCodeMessageId("descending");
  }

  private internalMessageRetentionMs(): number {
    const configured = Number(process.env.FLOWDECK_INTERNAL_MESSAGE_RETENTION_MS);
    // Default to seven days. Clamp external configuration to one minute through
    // ninety days so malformed or extreme values cannot disable bounded cleanup.
    if (!Number.isFinite(configured) || configured <= 0) return 7 * 24 * 60 * 60 * 1000;
    return Math.min(90 * 24 * 60 * 60 * 1000, Math.max(60 * 1000, Math.floor(configured)));
  }

  private internalMessageMaintenanceIntervalMs(): number {
    const configured = Number(process.env.FLOWDECK_INTERNAL_MESSAGE_MAINTENANCE_INTERVAL_MS);
    // Event-driven maintenance runs at most once per minute by default. No timer
    // is scheduled; the next normal adapter event performs the work when due.
    if (!Number.isFinite(configured) || configured < 0) return 60 * 1000;
    return Math.min(24 * 60 * 60 * 1000, Math.floor(configured));
  }

  private maintainInternalMessageProvenance(now = Date.now()): void {
    if (now - this.lastInternalMessagePruneAt < this.internalMessageMaintenanceIntervalMs()) return;
    this.lastInternalMessagePruneAt = now;
    const cutoff = new Date(now - this.internalMessageRetentionMs()).toISOString();
    this.lastInternalMessagePruneCount = this.runtime.internalMessageProvenanceRepo.pruneExpired(cutoff);
  }

  getInternalMessageProvenanceDiagnostics(): {
    retentionMs: number;
    maintenanceIntervalMs: number;
    lastPrunedAt: string | null;
    lastPrunedCount: number;
    totalCount: number;
    oldestCreatedAt: string | null;
  } {
    const stats = this.runtime.internalMessageProvenanceRepo.getStats();
    return {
      retentionMs: this.internalMessageRetentionMs(),
      maintenanceIntervalMs: this.internalMessageMaintenanceIntervalMs(),
      lastPrunedAt: this.lastInternalMessagePruneAt ? new Date(this.lastInternalMessagePruneAt).toISOString() : null,
      lastPrunedCount: this.lastInternalMessagePruneCount,
      ...stats,
    };
  }

  private getPathFingerprint(relPath: string): string {
    return getMutationTargetFingerprint(this.directory, [relPath]);
  }

  /**
   * Repo Master contributes only bounded repository evidence. Routing, SpecialistPlan,
   * native execution, VerificationService, and CompletionPolicy retain their authority.
   */
  private consultRepoMaster(runId: string, decision: RouterDecision, goal: string): { advice?: RepoMasterAdvice; requirement: "none" | "optional" | "required" } {
    const executionMode = decision.executionMode ?? executionModeForClass(decision.executionClass);
    const request = { runId, goal, executionMode, decision };
    const requirement = repoMasterConsultationRequirement(request);
    if (requirement === "none") return { requirement };
    if (!this.runtime.repoMaster) {
      if (requirement === "required") throw new Error("REPO_MASTER_REQUIRED_UNAVAILABLE");
      return { requirement };
    }
    try {
      const startedAt = performance.now();
      const result = this.runtime.repoMaster.consult(request);
      this.runtime.metrics?.recordRepoMasterConsultation?.({
        cacheHit: result.cacheHit,
        refreshed: result.refreshed,
        fresh: this.runtime.repoMaster.isAdviceFresh(result.advice),
        latencyMs: performance.now() - startedAt,
      });
      return { advice: result.advice, requirement };
    } catch (error) {
      if (requirement === "required") {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`REPO_MASTER_REQUIRED_CONSULTATION_FAILED: ${detail}`);
      }
      return { requirement };
    }
  }

  private isRepoMasterAdviceFresh(advice: RepoMasterAdvice | null): boolean {
    return Boolean(advice && this.runtime.repoMaster?.isAdviceFresh(advice));
  }

  async onChatMessage(
    input: { sessionID: string; agent?: string; messageID?: string },
    output: { message: UserMessage; parts: Part[] }
  ) {
    if (this.disposed) return;
    if (this.startupReadyPromise) await this.startupReadyPromise;
    this.maintainInternalMessageProvenance();
    if (input.agent === "heidi" || input.agent === "orchestrator" || !input.agent) {
      const text = output.parts
        .filter((p): p is TextPart => p.type === "text")
        .map(p => p.text)
        .join("\n");

      if (!text.trim()) return;

      // OpenCode transports FlowDeck promptAsync traffic as role=user. Semantic
      // provenance is therefore recovered exclusively from FlowDeck's durable
      // native message-ID reservation; prompt text and transport role never grant
      // or remove user authority.
      if (this.runtime.internalMessageProvenanceRepo.isInternal(input.sessionID, input.messageID)) {
        noteInternalContinuation(input.sessionID);
        return;
      }

      const msgHash = stableHash(text);
      const _currentTurn = this.runtime.sessionTurnRepo?.incrementTurnVersion({
        sessionId: input.sessionID,
        messageId: input.messageID,
        messageHash: msgHash,
      }) ?? { turnVersion: ++this.turnVersionCounter, replay: false };

      const correlationId = input.messageID || randomUUID();

      // 1. Resolve durable active Run from SQLite
      const activeRun = await this.resolveActiveRunForSession(input.sessionID);

      if (activeRun) {
        let currentRoute = getRouteDecision(input.sessionID);
        if (!currentRoute) {
          const latestDecision = this.runtime.routingDecisionRepository.getLatestDecisionForRun(activeRun.id);
          if (latestDecision) {
            const reconstructed = reconstructRouterDecision(latestDecision);
            if (reconstructed) {
              setRouteDecision(
                input.sessionID,
                activeRun.id,
                reconstructed.decision,
                reconstructed.goal,
                reconstructed.lastUserMessageHash
              );
              currentRoute = getRouteDecision(input.sessionID);
            }
          }
        }

        const lastHash =
          currentRoute?.lastUserMessageHash ??
          (activeRun.metadata?.lastUserMessageHash as string | undefined);

        const currentGoal =
          currentRoute?.goal ??
          (activeRun.metadata?.goal as string | undefined);

        const intentResult = classifyUserTurnIntent({
          currentGoal,
          newMessage: text,
          activeRunStatus: activeRun.status,
          messageHash: msgHash,
          lastMessageHash: lastHash,
        });

        switch (intentResult.intent) {
          case "REPLAY":
          case "CONTINUE":
          case "QUERY":
          case "ACKNOWLEDGE": {
            noteInternalContinuation(input.sessionID);
            return;
          }

          case "MODIFY": {
            const modResult = this.runtime.routingRevisionService.applyModification({
              runId: activeRun.id,
              sessionID: input.sessionID,
              modificationText: text,
              newMessageHash: msgHash,
              directory: this.directory,
            });

            if (modResult.outcome === "modified") {
              const route = getRouteDecision(input.sessionID);
              if (route) {
                route.goal = modResult.effectiveGoal;
                route.lastUserMessageHash = msgHash;
                const rec = reconstructRouterDecision(modResult.decision);
                if (rec) {
                  route.decision = rec.decision;
                }
                noteInternalContinuation(input.sessionID);
              }
              // Record progress event without mutating/relying on ephemeral Run.metadata
              await this.runtime.services.runService.updateRun(activeRun.id, {
                progress: activeRun.progressPercent,
                stage: activeRun.stage,
              });
              return;
            }

            // Material reclassification -> check shared cancellation barrier before starting new Run
            const safety = await this.cancelAndCheckReplacementSafety(
              activeRun.id,
              "Superseded by modified user goal requiring reclassification"
            );

            if (safety === "TERMINATION_PENDING") {
              this.runtime.deferredReplacementRepo.savePending({
                parentSessionId: input.sessionID,
                oldRunId: activeRun.id,
                sourceIntent: "MODIFY_RECLASSIFICATION",
                agentId: input.agent ?? "heidi",
                effectiveGoal: modResult.effectiveGoal,
                messageHash: msgHash,
                messageId: correlationId,
                correlationId,
                routingDecision: modResult.newDecision,
              });
              return;
            }

            markRouteInactive(input.sessionID);

            const taskId = "task-" + randomUUID();
            this.turnVersionCounter += 1;
            const turnVersion = this.turnVersionCounter;

            setRouteDecision(input.sessionID, taskId, modResult.newDecision, modResult.effectiveGoal, msgHash);

            if (modResult.newDecision.executionClass === "FAST_DIRECT") {
              this.runtime.metrics.recordSpecialistPlan("DIRECT");
              this.pendingFastDirectTurns.set(input.sessionID, {
                sessionID: input.sessionID,
                taskId,
                messageHash: msgHash,
                messageID: correlationId,
                turnVersion,
              });
            } else {
              await this.syncOrchestrationRun(
                taskId,
                input.sessionID,
                input.agent ?? "heidi",
                modResult.newDecision,
                modResult.effectiveGoal,
                msgHash,
                correlationId
              );
            }
            return;
          }

          case "CANCEL": {
            try {
              await this.runtime.services.runService.cancelRun(
                activeRun.id,
                "Cancelled by user instruction"
              );
            } catch (err: any) {
              if (err?.code !== ErrorCodes.RUN_IN_TERMINAL_STATE) {
                console.error("[FlowDeckLifecycleAdapter] cancelRun error:", err);
              }
            }
            this.runtime.deferredReplacementRepo.cancelCurrentForSession(input.sessionID);
            markRouteInactive(input.sessionID);
            return;
          }

          case "REPLACE": {
            const safety = await this.cancelAndCheckReplacementSafety(
              activeRun.id,
              "Superseded by newer user goal"
            );

            if (safety === "TERMINATION_PENDING") {
              const decision = classifyTask(text, { hasExplicitDomainSignal: false });
              this.runtime.deferredReplacementRepo.savePending({
                parentSessionId: input.sessionID,
                oldRunId: activeRun.id,
                sourceIntent: "REPLACE",
                agentId: input.agent ?? "heidi",
                effectiveGoal: text,
                messageHash: msgHash,
                messageId: correlationId,
                correlationId,
                routingDecision: decision,
              });
              return;
            }
            markRouteInactive(input.sessionID);
            break;
          }
        }
      }

      // 2. Check if this session has an unresolved deferred replacement
      const existingDeferred = this.runtime.deferredReplacementRepo?.findCurrentForSession(input.sessionID);
      if (existingDeferred) {
        const diag = this.runtime.childExecutionLifecycleService.getDiagnosticsForRun(existingDeferred.oldRunId);
        const userIntent = classifyUserTurnIntent({
          currentGoal: existingDeferred.effectiveGoal,
          newMessage: text,
          activeRunStatus: "cancelled" as any,
          messageHash: msgHash,
          lastMessageHash: existingDeferred.messageHash,
        });

        if (userIntent.intent === "CANCEL") {
          this.runtime.deferredReplacementRepo.cancelCurrentForSession(input.sessionID);
          markRouteInactive(input.sessionID);
          return;
        }

        if (userIntent.intent === "REPLAY") {
          // Replay of existing message; preserve current deferred state and ignore idempotently
          noteInternalContinuation(input.sessionID);
          return;
        }

        if (userIntent.intent === "CONTINUE" || userIntent.intent === "QUERY" || userIntent.intent === "ACKNOWLEDGE") {
          // Conversational, query, or acknowledgement; preserve current deferred goal unchanged
          noteInternalContinuation(input.sessionID);
          return;
        }

        if (userIntent.intent === "MODIFY") {
          // Requirement refinement: intentionally update/reclassify current deferred goal
          const modifiedGoal = `${existingDeferred.effectiveGoal}\n\n[User Modification]: ${text}`;
          const decision = classifyTask(modifiedGoal, { hasExplicitDomainSignal: false });
          this.runtime.deferredReplacementRepo.savePending({
            parentSessionId: input.sessionID,
            oldRunId: existingDeferred.oldRunId,
            sourceIntent: "MODIFY_RECLASSIFICATION",
            agentId: input.agent ?? "heidi",
            effectiveGoal: modifiedGoal,
            messageHash: msgHash,
            messageId: correlationId,
            correlationId,
            routingDecision: decision,
          });
          if (!diag?.currentTerminationPending) {
            // Keep detached recovery work ownership-bound to this adapter. Terminal
            // runtime disposal waits for it before closing persistence.
            void this.trackLifecycleTask(this.drainSafeDeferredReplacements()).catch(() => {});
          }
          return;
        }

        // Default / REPLACE: Newer genuine user intent wins and supersedes older deferred replacement
        const decision = classifyTask(text, { hasExplicitDomainSignal: false });
        this.runtime.deferredReplacementRepo.savePending({
          parentSessionId: input.sessionID,
          oldRunId: existingDeferred.oldRunId,
          sourceIntent: "REPLACE",
          agentId: input.agent ?? "heidi",
          effectiveGoal: text,
          messageHash: msgHash,
          messageId: correlationId,
          correlationId,
          routingDecision: decision,
        });
        if (!diag?.currentTerminationPending) {
          // See MODIFY above: the task remains adapter-owned until it settles.
          void this.trackLifecycleTask(this.drainSafeDeferredReplacements()).catch(() => {});
        }
        return;
      }

      // 3. Check for exact duplicate of ephemeral/initial turn
      if (isDuplicateMessage(input.sessionID, msgHash)) {
        noteInternalContinuation(input.sessionID);
        return;
      }

      // 4. Clear any prior FAST_DIRECT pending turn marker atomically
      this.pendingFastDirectTurns.delete(input.sessionID);

      // 5. Genuine new or replacement user instruction -> classify independently
      const decision = classifyTask(text, { hasExplicitDomainSignal: false });
      const taskId = "task-" + randomUUID();
      this.turnVersionCounter += 1;
      const turnVersion = this.turnVersionCounter;

      setRouteDecision(input.sessionID, taskId, decision, text, msgHash);

      if (decision.executionClass === "FAST_DIRECT") {
        this.runtime.metrics.recordSpecialistPlan("DIRECT");
        this.pendingFastDirectTurns.set(input.sessionID, {
          sessionID: input.sessionID,
          taskId,
          messageHash: msgHash,
          messageID: correlationId,
          turnVersion,
        });
      } else {
        await this.syncOrchestrationRun(taskId, input.sessionID, input.agent ?? "heidi", decision, text, msgHash, correlationId);
      }
    }
  }

  /** Resolves whether the session has an active non-terminal Run in SQLite. Also hydrates route state if found. */
  async resolveActiveRunForSession(sessionID: string) {
    const sessionRow = this.runtime.sessionRepo.findById(sessionID);
    if (!sessionRow) {
      return null;
    }

    const run = await this.runtime.services.runRepo.findById(sessionRow.runId);
    if (!run || isTerminalRunStatus(run.status)) {
      markRouteInactive(sessionID);
      return null;
    }

    // Hydrate route decision into memory if missing
    if (!getRouteDecision(sessionID)) {
      const routingDecision = this.runtime.routingDecisionRepository.getLatestDecisionForRun(run.id);
      if (routingDecision) {
        const reconstructed = reconstructRouterDecision(routingDecision);
        if (reconstructed) {
          setRouteDecision(sessionID, run.id, reconstructed.decision, reconstructed.goal, reconstructed.lastUserMessageHash);
        }
      }
    }

    return run;
  }

  /** Hydrates route state from authoritative SQLite persistence after a process restart or session resume. */
  async hydrateSessionRoute(sessionID: string): Promise<void> {
    await this.resolveActiveRunForSession(sessionID);
  }

  /** Persists Run, canonical RoutingDecision with real assessment, and binds session affinity. */
  private async syncOrchestrationRun(
    taskId: string,
    sessionID: string,
    agentId: string,
    decision: RouterDecision,
    goal: string,
    msgHash: string,
    correlationId: string,
  ): Promise<Run | null> {
    if (decision.executionClass === "FAST_DIRECT") return null;

    try {
      const runStrategy = mapExecutionClassToRunStrategy(decision.executionClass);
      const run = typeof this.runtime.services.runService.createOrGetRunByCorrelationId === "function"
        ? await this.runtime.services.runService.createOrGetRunByCorrelationId({
            runType: runStrategy,
            correlationId,
            sessionId: sessionID,
            agentId,
            metadata: { taskId, goal, lastUserMessageHash: msgHash },
          }, correlationId)
        : await this.runtime.services.runService.createRun({
            runType: runStrategy,
            correlationId,
            sessionId: sessionID,
            agentId,
            metadata: { taskId, goal, lastUserMessageHash: msgHash },
          });

      // Consult bounded repository intelligence before routing persistence. The Router and
      // SpecialistPlan remain authoritative; required consultation failures stay explicit.
      const repoMaster = this.consultRepoMaster(run.id, decision, goal);
      const specialistSetupStartedAt = performance.now();
      const canonicalRouting = buildCanonicalRoutingDecision({
        runId: run.id,
        decision,
        goal,
        lastUserMessageHash: msgHash,
        directory: this.directory,
        repoMasterAdvice: repoMaster.advice,
      });
      this.runtime.routingDecisionRepository.saveDecision(canonicalRouting);
      const specialistPlan = specialistPlanFromRoutingDecision(canonicalRouting);
      if (specialistPlan) {
        this.runtime.metrics.recordSpecialistPlan(specialistPlan.executionMode, {
          deduplicated: specialistPlan.deduplicated,
          fanoutBlocked: specialistPlan.fanoutBlocked,
          setupLatencyMs: performance.now() - specialistSetupStartedAt,
        });
      }

      // Bind session -> active run
      this.runtime.sessionRepo.bindActiveRun({
        id: sessionID,
        runId: run.id,
        agentId,
        status: "running",
      });
      return run;
    } catch (err) {
      console.error("[FlowDeckLifecycleAdapter] syncOrchestrationRun failed:", err);
      return null;
    }
  }

  async onToolExecuteBefore(
    input: { tool: string; sessionID: string; callID: string; args?: any }
  ) {
    if (this.disposed) return;
    if (this.startupReadyPromise) await this.startupReadyPromise;

    // Track pre-state fingerprint for mutating tools using normalized mutation target extraction
    const mutationTargets = extractMutationTargets(input.tool, input.args);
    if (mutationTargets.canFingerprintPrecisely) {
      this.preToolRepositoryFingerprints.set(
        input.callID,
        getMutationTargetFingerprint(this.directory, mutationTargets.targetPaths)
      );
    }

    // Resolve assignment and run for tool attempt tracking
    // 1. Child session tool attribution check
    const childRec = this.runtime.childExecutionLifecycleService.getChildExecution({ childSessionId: input.sessionID });
    let runId: string | undefined;
    let assignmentId: string | undefined;

    if (childRec) {
      runId = childRec.runId;
      assignmentId = childRec.assignmentId;
    } else {
      // 2. Parent-session execution boundary: block tool execution while prior child termination is pending or handoff unresolved
      const deferred = this.runtime.deferredReplacementRepo?.findCurrentForSession(input.sessionID);
      if (deferred) {
        const diag = this.runtime.childExecutionLifecycleService?.getDiagnosticsForRun(deferred.oldRunId);
        const unresolvedBarrier =
          diag?.currentTerminationPending ||
          deferred.status === "pending_termination" ||
          deferred.status === "resuming" ||
          deferred.status === "handoff_pending" ||
          deferred.status === "handoff_outcome_unknown" ||
          deferred.status === "blocked";

        if (unresolvedBarrier) {
          throw new Error(
            `[ExecutionBoundary] DEFERRED_REPLACEMENT_BARRIER: Parent session '${input.sessionID}' is waiting for prior child execution termination before deferred replacement can proceed. Tool '${input.tool}' rejected.`
          );
        }
      }

      const activeRun = await this.resolveActiveRunForSession(input.sessionID);
      if (activeRun) {
        runId = activeRun.id;
        const snapshot = this.runtime.orchestrationSnapshotService.getSnapshot(activeRun.id, input.sessionID);
        assignmentId = snapshot?.currentWorkItemId ?? ("root:" + activeRun.id);
      }
    }

    if (runId && assignmentId) {
      const actionFingerprint = this.runtime.progressObservationService.computeActionFingerprint({
        tool: input.tool,
        args: input.args,
        sessionID: input.sessionID,
      });
      const snapshot = this.runtime.orchestrationSnapshotService.getSnapshot(runId, input.sessionID);
      const preStateFingerprint = this.runtime.transitionEngine.computeStrategyStateFingerprint(runId, assignmentId, snapshot);

      // Boundary Enforcement: Check active strategy constraint set before execution
      const activeConstraintSet = this.runtime.transitionEngine.getActiveStrategyConstraints(runId, assignmentId);
      if (activeConstraintSet && activeConstraintSet.stateFingerprint === preStateFingerprint) {
        if (activeConstraintSet.exhausted) {
          throw new Error(
            `[ExecutionBoundary] STRATEGY_SET_EXHAUSTED: Strategy set exhausted under unchanged state '${preStateFingerprint}'. Replan or resolve state before attempting further tools.`
          );
        }
        if (activeConstraintSet.prohibitedActionFingerprints.includes(actionFingerprint)) {
          const reason = activeConstraintSet.reasonsByFingerprint?.[actionFingerprint] ?? "REPEATED_ACTION_BLOCKED";
          throw new Error(
            `[ExecutionBoundary] REPEATED_ACTION_BLOCKED: Action '${input.tool}' with fingerprint '${actionFingerprint}' is prohibited under unchanged state '${preStateFingerprint}'. ${reason}.`
          );
        }
      } else if (activeConstraintSet && activeConstraintSet.stateFingerprint !== preStateFingerprint) {
        // Meaningful state has changed; clear outdated constraint set and allow execution
        this.runtime.transitionEngine.clearStrategyConstraint(runId, assignmentId);
      }

      const startedAttempt = this.runtime.transitionEngine.startAttempt({
        runId,
        assignmentId,
        callID: input.callID,
        tool: input.tool,
        actionFingerprint,
        preStateFingerprint,
      });

      this.inFlightAttempts.set(input.callID, {
        runId,
        assignmentId,
        attemptNumber: startedAttempt.attemptNumber,
        preStateFingerprint,
        actionFingerprint,
        startedAt: startedAttempt.startedAt,
      });
    }

    if (input.tool === "task" || input.tool === "subagent") {
      const activeRun = childRec ? null : await this.resolveActiveRunForSession(input.sessionID);
      const effectiveRunId = childRec?.runId ?? activeRun?.id;
      const normalized = normalizeTaskInvocation(
        { sessionID: input.sessionID, callID: input.callID },
        input.args ?? {}
      );
      if (effectiveRunId) {
        const specialistId = specialistIdFromNativeTask(normalized.prompt, normalized.description);
        const existingChild = this.runtime.childExecutionLifecycleService.getChildExecution({ taskCallId: input.callID });
        await this.runtime.childExecutionLifecycleService.registerDelegation({
          runId: effectiveRunId,
          parentSessionId: input.sessionID,
          taskCallId: input.callID,
          targetAgent: normalized.targetAgent,
          specialistId,
          prompt: normalized.prompt,
          description: normalized.description,
          background: normalized.background,
        });
        if (specialistId && !existingChild) this.runtime.metrics.recordSpecialistSpawn();
      }
    }
  }

  async onToolExecuteAfter(
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: { output: string; metadata: any; title?: string }
  ) {
    if (this.disposed) return;
    if (this.startupReadyPromise) await this.startupReadyPromise;
    if (input.sessionID) {
      try {
        const isDelegation = input.tool === "task" || input.tool === "subagent";
        this.runtime.sessionRepo.incrementMetrics(input.sessionID, 1, isDelegation ? 1 : 0);
      } catch {
        // Safe fail
      }
    }

    // 1. Resolve attempt (in-memory cache or durable fallback by callID)
    const inFlight = this.inFlightAttempts.get(input.callID) ?? this.runtime.transitionEngine.findAttemptByCallID(input.callID);
    if (this.inFlightAttempts.has(input.callID)) {
      this.inFlightAttempts.delete(input.callID);
    }

    if (input.tool === "task" || input.tool === "subagent") {
      const trans = await this.runtime.childExecutionLifecycleService.markCompleted({
        taskCallId: input.callID,
        output: output?.output,
        title: output?.title,
        metadata: output?.metadata,
      });
      if (trans && trans.changed) {
        this.runtime.progressObservationService.recordChildLifecycleObservation({
          runId: trans.record.runId,
          sessionId: input.sessionID,
          assignmentId: trans.record.assignmentId,
          executionId: trans.record.executionId,
          previousState: trans.previousState,
          newState: "completed",
          result: output?.output,
        });
      }

      // Finalize the task/subagent tool attempt as well
      if (inFlight) {
        const resultFingerprint = this.runtime.progressObservationService.computeResultFingerprint({
          tool: input.tool,
          output: output?.output,
          metadata: output?.metadata,
          error: output?.metadata?.error,
        });
        const isProgress = trans ? trans.changed : false;
        this.runtime.transitionEngine.finalizeAttempt({
          runId: inFlight.runId,
          assignmentId: inFlight.assignmentId,
          attemptNumber: inFlight.attemptNumber,
          resultFingerprint,
          postStateFingerprint: trans?.record.executionId ? "child:" + trans.record.executionId + ":completed" : undefined,
          finishedAt: new Date().toISOString(),
          progressProduced: isProgress,
          repositoryDelta: 0,
          evidenceDelta: isProgress ? 1 : 0,
          verificationDelta: 0,
          childStateDelta: isProgress ? 1 : 0,
          evidenceIds: trans?.record.executionId ? ["child_res:" + trans.record.executionId] : [],
        });
      }
    } else {
      // Ordinary tool execution observation inside session or child session
      const childRec = this.runtime.childExecutionLifecycleService.getChildExecution({ childSessionId: input.sessionID });
      const activeRun = childRec ? null : await this.resolveActiveRunForSession(input.sessionID);
      const runId = childRec?.runId ?? activeRun?.id;
      if (runId) {
        let preHash: string | undefined;
        let postHash: string | undefined;
        const postTargets = extractMutationTargets(input.tool, input.args);
        if (postTargets.canFingerprintPrecisely) {
          preHash = this.preToolRepositoryFingerprints.get(input.callID);
          this.preToolRepositoryFingerprints.delete(input.callID);
          postHash = getMutationTargetFingerprint(this.directory, postTargets.targetPaths);
        }

        const obs = this.runtime.progressObservationService.recordToolObservation({
          runId,
          sessionId: input.sessionID,
          tool: input.tool,
          args: input.args,
          output: output?.output,
          metadata: output?.metadata,
          error: output?.metadata?.error ? String(output.metadata.error) : undefined,
          preRepositoryHash: preHash,
          postRepositoryHash: postHash,
          assignmentId: childRec?.assignmentId,
          executionId: childRec?.executionId,
        });
        if (obs.repositoryStateDelta > 0) {
          this.runtime.repoMaster?.invalidate(postTargets.targetPaths);
        }

        if (inFlight) {
          const resultFingerprint = this.runtime.progressObservationService.computeResultFingerprint({
            tool: input.tool,
            output: output?.output,
            metadata: output?.metadata,
            error: output?.metadata?.error,
          });
          const isTransient = this.runtime.transitionEngine.isTransientError(output?.metadata?.error);
          const isProgress = (obs.evidenceDelta > 0 && obs.evidenceKind !== "informational") || obs.repositoryStateDelta > 0 || obs.verificationDelta > 0;

          this.runtime.transitionEngine.finalizeAttempt({
            runId: inFlight.runId,
            assignmentId: inFlight.assignmentId,
            attemptNumber: inFlight.attemptNumber,
            resultFingerprint,
            postStateFingerprint: obs.repositoryStateDelta + ":" + obs.evidenceDelta,
            finishedAt: new Date().toISOString(),
            progressProduced: isProgress,
            repositoryDelta: obs.repositoryStateDelta,
            evidenceDelta: obs.evidenceDelta,
            verificationDelta: obs.verificationDelta,
            childStateDelta: obs.executionStateDelta,
            isTransientError: isTransient,
            failureReason: output?.metadata?.error ? String(output.metadata.error) : undefined,
          });
        }
      }
    }
  }

  async onEvent(event: Event) {
    if (this.disposed) return;
    if (this.startupReadyPromise) await this.startupReadyPromise;
    const eventType = (event as any).type ?? (event as any).event;
    const props = ((event as any).properties ?? (event as any).data ?? event ?? {}) as any;

    if (eventType === "session.created") {
      const info = props.info ?? props;
      const childSessionId = info.id ?? props.sessionID;
      const parentSessionId = info.parentID ?? props.parentSessionID ?? props.parentID;
      const agentId = info.agent ?? props.agent;
      if (childSessionId && parentSessionId) {
        const bound = this.runtime.childExecutionLifecycleService.bindChildSession({
          parentSessionId,
          childSessionId,
          agentId,
        });
        if (bound) {
          const trans = await this.runtime.childExecutionLifecycleService.markStarted({
            childSessionId,
          });
          if (trans && trans.changed) {
            this.runtime.progressObservationService.recordChildLifecycleObservation({
              runId: bound.runId,
              sessionId: parentSessionId,
              assignmentId: bound.assignmentId,
              executionId: bound.executionId,
              previousState: trans.previousState,
              newState: "running",
            });
          }
        }
      }
    } else if (eventType === "session.idle") {
      const sid = props.sessionID ?? props.id;
      if (sid) {
        await this.onSessionIdle(sid);
      }
    } else if (eventType === "session.error") {
      const sid = props.sessionID ?? props.session_id ?? props.id ?? "unknown";
      await this.onSessionError(sid, props.error);
    } else if (eventType === "session.deleted") {
      const sid = props.info?.id ?? props.sessionID ?? props.id ?? "unknown";
      await this.onSessionDeleted(sid);
    }
  }

  async onSessionError(sessionID: string, error: any) {
    if (this.disposed) return;
    // 1. Check if session.error belongs to a registered child execution
    const childRec = this.runtime.childExecutionLifecycleService.getChildExecution({ childSessionId: sessionID });
    if (childRec) {
      const trans = await this.runtime.childExecutionLifecycleService.markFailed({
        childSessionId: sessionID,
        error: error ? String(error.message ?? error) : "Session error occurred",
      });
      if (trans && trans.changed) {
        if (childRec.specialistId) this.runtime.metrics.recordSpecialistFailure();
        this.runtime.progressObservationService.recordChildLifecycleObservation({
          runId: childRec.runId,
          sessionId: sessionID,
          assignmentId: childRec.assignmentId,
          executionId: childRec.executionId,
          previousState: trans.previousState,
          newState: "failed",
          error: trans.record.error,
        });
      }
    }
  }

  /**
   * Dispatches the smallest ready persisted specialist batch through the existing
   * bounded parent-session native prompt channel. It never creates child sessions
   * or lifecycle records itself: OpenCode Task/subagent events remain the only
   * source of native child identity and ChildExecutionLifecycleService remains
   * their authoritative registrar.
   */
  private async dispatchReadySpecialists(activeRun: Run, sessionId: string): Promise<boolean> {
    // A specialist session cannot create a new team. Heidi is the sole dispatcher.
    if (isTerminalRunStatus(activeRun.status) || this.runtime.childExecutionLifecycleService.getChildExecution({ childSessionId: sessionId })) return false;
    const deferred = this.runtime.deferredReplacementRepo.findCurrentForSession(sessionId);
    if (deferred?.oldRunId === activeRun.id) return false;

    let decision = this.runtime.routingDecisionRepository.getLatestDecisionForRun(activeRun.id);
    let plan = decision ? specialistPlanFromRoutingDecision(decision) : null;
    const persistedAdvice = decision ? repoMasterAdviceFromRoutingDecision(decision) : null;
    const reconstructed = decision ? reconstructRouterDecision(decision) : null;
    if (reconstructed) {
      const requirement = repoMasterConsultationRequirement({
        goal: reconstructed.goal,
        executionMode: reconstructed.decision.executionMode ?? executionModeForClass(reconstructed.decision.executionClass),
        decision: reconstructed.decision,
      });
      if (requirement !== "none" && !this.isRepoMasterAdviceFresh(persistedAdvice)) {
        try {
          const refreshed = this.consultRepoMaster(activeRun.id, reconstructed.decision, reconstructed.goal);
          decision = buildCanonicalRoutingDecision({
            runId: activeRun.id,
            decision: reconstructed.decision,
            goal: reconstructed.goal,
            lastUserMessageHash: reconstructed.lastUserMessageHash,
            directory: this.directory,
            repoMasterAdvice: refreshed.advice,
          });
          this.runtime.routingDecisionRepository.saveDecision(decision);
          plan = specialistPlanFromRoutingDecision(decision);
        } catch (error) {
          // Required consultation failure is explicit in durable dispatch behavior; no stale
          // or invented repository evidence may be used to launch specialists.
          console.warn("[FlowDeckLifecycleAdapter] specialist dispatch blocked:", error);
          return false;
        }
      }
    }
    if (!plan || plan.specs.length === 0 || plan.rejectedReason) return false;

    const children = this.runtime.childExecutionLifecycleService.listChildExecutionsForRun(activeRun.id);
    const settled = new Set(
      children
        .filter(child => child.status === "completed")
        .map(child => child.specialistId)
        .filter((id): id is string => Boolean(id))
    );
    const launched = new Set(
      children
        .map(child => child.specialistId)
        .filter((id): id is string => Boolean(id))
    );
    const ready = readySpecialistSpecs(plan, settled).filter(spec => !launched.has(spec.specialistId));
    if (ready.length === 0) return false;

    const snapshot = this.runtime.orchestrationSnapshotService.getSnapshot(activeRun.id, sessionId);
    const stateFingerprint = this.runtime.orchestrationSnapshotService.computeStateFingerprint(activeRun.id, sessionId) ??
      `${activeRun.id}:${ready.map(spec => spec.specialistId).join(",")}`;
    const token: ContinuationToken = {
      runId: activeRun.id,
      sessionId,
      userTurnVersion: this.runtime.sessionTurnRepo.getTurnVersion(sessionId),
      runAggregateVersion: snapshot?.aggregateVersion ?? this.runtime.taskRunsRepo.findById(activeRun.id)?.aggregateVersion ?? 0,
      transitionReason: "PROGRESS_CONFIRMED",
      currentWorkItemId: `specialist:${ready.map(spec => spec.specialistId).join(",")}`,
      stateFingerprint,
    };
    const promptText = [
      "[FlowDeck Specialist Dispatch] Use OpenCode native Task/subagent calls only for the following ready specialist assignments.",
      "Do not delegate recursively, do not choose or override a model, and do not create tasks outside this list.",
      "Each Task must be background-capable and include its exact FlowDeck specialist marker in its prompt and description.",
      ...ready.map(spec => `- targetAgent=${spec.targetAgent}; description=[FlowDeck specialist:${spec.specialistId}] ${spec.role}; prompt=[FlowDeck specialist:${spec.specialistId}] Objective: ${spec.objective}; Scope: ${spec.scope.join(", ")}; Required evidence: ${spec.expectedEvidence.join(", ")}.`),
    ].join("\n");

    const internalMessageId = this.newInternalPromptMessageId();
    const dispatchIdentity = this.continuationDispatcher.computeTokenIdentity(token);
    const dispatched = await this.continuationDispatcher.dispatch(token, {
      client: this.client,
      promptText,
      messageId: internalMessageId,
      beforeNativeDispatch: () => this.reserveInternalPrompt({
        sessionId,
        messageId: internalMessageId,
        provenance: "FLOWDECK_SPECIALIST_DISPATCH",
        dispatchIdentity,
      }),
      validateAuthority: () => {
        const current = this.runtime.routingDecisionRepository.getLatestDecisionForRun(activeRun.id);
        const currentPlan = current ? specialistPlanFromRoutingDecision(current) : null;
        const currentAdvice = current ? repoMasterAdviceFromRoutingDecision(current) : null;
        const currentRoute = current ? reconstructRouterDecision(current) : null;
        const currentRequirement = currentRoute
          ? repoMasterConsultationRequirement({
              goal: currentRoute.goal,
              executionMode: currentRoute.decision.executionMode ?? executionModeForClass(currentRoute.decision.executionClass),
              decision: currentRoute.decision,
            })
          : "required";
        const currentAdviceAllowed = currentRequirement === "required"
          ? Boolean(currentAdvice && this.isRepoMasterAdviceFresh(currentAdvice))
          : !currentAdvice || this.isRepoMasterAdviceFresh(currentAdvice);
        const currentDeferred = this.runtime.deferredReplacementRepo.findCurrentForSession(sessionId);
        const currentRun = this.runtime.taskRunsRepo.findById(activeRun.id);
        return Boolean(
          currentRun
          && !isTerminalRunStatus(currentRun.state as Run["status"])
          && currentRun.aggregateVersion === token.runAggregateVersion
          && this.runtime.sessionTurnRepo.getTurnVersion(sessionId) === token.userTurnVersion
          && !currentDeferred
          && currentAdviceAllowed
          && currentPlan
          && currentPlan.runId === activeRun.id
          && currentPlan.specs.some(spec => spec.specialistId === ready[0]?.specialistId)
        );
      },
    });
    return dispatched.dispatched;
  }

  private async runLiveVerification(runId: string, sessionId: string): Promise<void> {
    const snapshot = this.runtime.orchestrationSnapshotService.getSnapshot(runId, sessionId);
    const stateFingerprint = this.runtime.orchestrationSnapshotService.computeStateFingerprint(runId, sessionId);
    if (!snapshot || !stateFingerprint || snapshot.phase !== OP.VERIFYING || snapshot.terminalState?.isTerminal) return;

    const requiredWorkItems = snapshot.workItems.filter(item => item.isRequired);
    const evidenceIds = requiredWorkItems.flatMap(item => item.evidenceIds);
    const request = await this.runtime.services.verificationService.requestLiveVerification({
      runId,
      stateVersion: snapshot.aggregateVersion,
      stateFingerprint,
      checkType: "live_orchestration",
      correlationId: runId,
      targetSha: this.runtime.taskRunsRepo.findById(runId)?.currentSha ?? this.runtime.taskRunsRepo.findById(runId)?.baselineSha,
      evidenceIds,
    });

    // Reconstruct state after the durable request. The request alone is not a result.
    const currentSnapshot = this.runtime.orchestrationSnapshotService.getSnapshot(runId, sessionId);
    const currentFingerprint = this.runtime.orchestrationSnapshotService.computeStateFingerprint(runId, sessionId);
    if (
      !currentSnapshot ||
      currentSnapshot.aggregateVersion !== request.stateVersion ||
      currentFingerprint !== request.stateFingerprint ||
      currentSnapshot.phase !== OP.VERIFYING
    ) {
      await this.runtime.services.verificationService.markLiveVerificationStale(
        request.id,
        "STATE_CHANGED_BEFORE_VERIFICATION_EVALUATION",
      );
      return;
    }

    const currentRequired = currentSnapshot.workItems.filter(item => item.isRequired);
    const allRequiredSatisfied = currentRequired.length > 0 && currentRequired.every(item => item.isSatisfied);
    const evaluationEvidenceIds = currentRequired.flatMap(item => item.evidenceIds);
    const failureReasons: string[] = [];
    if (!allRequiredSatisfied) failureReasons.push("REQUIRED_WORK_INCOMPLETE");
    if (currentSnapshot.childState.activeRequired > 0) failureReasons.push("REQUIRED_CHILD_ACTIVE");
    if (currentSnapshot.childState.failedRequired > 0) failureReasons.push("REQUIRED_CHILD_FAILED");
    if (currentSnapshot.lifecycleBlocks.cancellationPending) failureReasons.push("CANCELLATION_BARRIER_UNRESOLVED");
    if (currentSnapshot.lifecycleBlocks.unresolvedDeferredReplacement) failureReasons.push("DEFERRED_REPLACEMENT_UNRESOLVED");

    const result = await this.runtime.services.verificationService.evaluateLiveVerification(request.id, {
      requiredChecksComplete: allRequiredSatisfied && currentSnapshot.childState.activeRequired === 0,
      requiredChecksPassed: failureReasons.length === 0,
      evidenceIds: evaluationEvidenceIds,
      failureReasons,
    });

    // A result may only influence the Run if it still belongs to the same persisted state.
    const applyFingerprint = this.runtime.orchestrationSnapshotService.computeStateFingerprint(runId, sessionId);
    if (
      result.stateVersion === undefined ||
      !result.stateFingerprint ||
      applyFingerprint !== result.stateFingerprint
    ) {
      await this.runtime.services.verificationService.markLiveVerificationStale(
        result.id,
        "STATE_CHANGED_BEFORE_VERIFICATION_RESULT_APPLICATION",
      );
      return;
    }

    const observed = this.runtime.transitionEngine.observeVerificationResult({
      runId,
      stateVersion: result.stateVersion,
      stateFingerprint: result.stateFingerprint,
      status: result.status === "passed" ? "passed" : "failed",
    });
    if (observed.reasonCode === "VERIFICATION_STALE") {
      await this.runtime.services.verificationService.markLiveVerificationStale(
        result.id,
        "STATE_CHANGED_DURING_VERIFICATION_RESULT_APPLICATION",
      );
      return;
    }

    if (result.status === "passed" && observed.reasonCode === "VERIFICATION_PASSED") {
      this.runtime.completionPolicy.evaluateAndComplete({
        runId,
        sessionId,
        verificationId: result.id,
      });
    }

    this.runtime.progressObservationService.recordVerificationObservation({
      runId,
      sessionId,
      verificationId: result.id,
      status: result.status,
      passed: result.status === "passed" ? 1 : 0,
      failed: result.status === "failed" ? 1 : 0,
      evidenceIds: result.evidenceIds,
      fingerprint: `${result.status === "passed" ? 1 : 0}:${result.status === "failed" ? 1 : 0}:${result.stateFingerprint}`,
    });
  }

  async onSessionIdle(sessionID: string) {
    if (this.disposed) return;
    this.maintainInternalMessageProvenance();
    // 1. Only retire the route if this session is currently in an active FAST_DIRECT turn token
    if (sessionID && this.pendingFastDirectTurns.has(sessionID)) {
      this.pendingFastDirectTurns.delete(sessionID);
      markRouteInactive(sessionID);
      return;
    }

    // 2. Authoritative Run evaluation on idle
    const activeRun = await this.resolveActiveRunForSession(sessionID);
    if (!activeRun) return;

    let snapshot = this.runtime.orchestrationSnapshotService.getSnapshot(activeRun.id, sessionID);
    if (!snapshot) return;

    const transition = this.runtime.transitionEngine.evaluate({
      runId: activeRun.id,
      sessionId: sessionID,
    });

    // If evaluation changed the phase, refresh the snapshot so continuation token has post-transition state!
    if (transition.phaseChanged) {
      const refreshed = this.runtime.orchestrationSnapshotService.getSnapshot(activeRun.id, sessionID);
      if (refreshed) {
        snapshot = refreshed;
      }
    }

    // A validated persisted specialist plan is an independent source of ready
    // work, including the initial CREATED state before any native child exists,
    // but it remains downstream of transition evaluation. Recovering,
    // verifying, terminal, and strategy-exhausted runs cannot spawn.
    if (
      (snapshot.phase === OP.CREATED || snapshot.phase === OP.EXECUTING || snapshot.phase === OP.DELEGATING) &&
      transition.reasonCode !== "STRATEGY_SET_EXHAUSTED" &&
      await this.dispatchReadySpecialists(activeRun, sessionID)
    ) return;

    // session.idle merely triggers this deterministic path. Durable work, child,
    // barrier, and evidence state decide whether verification can happen.
    if (transition.reasonCode === "READY_FOR_VERIFICATION" && snapshot.phase === OP.VERIFYING) {
      await this.runLiveVerification(activeRun.id, sessionID);
      return;
    }

    const continuation = this.runtime.continuationPolicy.evaluate({
      snapshot,
      transition,
      hasActiveUserTurn: false,
      isStaleEvent: false,
    });

    // session.idle is a trigger to evaluate state, not evidence of work completion
    if (continuation.decision === "CONTINUE_NOW") {
      const currentTurnVersion = this.runtime.sessionTurnRepo.getTurnVersion(sessionID);
      const stateFingerprint = this.runtime.orchestrationSnapshotService.computeStateFingerprint(activeRun.id, sessionID) ??
        (snapshot.aggregateVersion + ":" + snapshot.phase + ":" + (snapshot.currentWorkItemId ?? ""));

      const token: ContinuationToken = {
        runId: activeRun.id,
        sessionId: sessionID,
        userTurnVersion: currentTurnVersion,
        runAggregateVersion: snapshot.aggregateVersion,
        transitionReason: transition.reasonCode,
        currentWorkItemId: snapshot.currentWorkItemId,
        stateFingerprint,
      };

      const statePort = {
        getUserTurnVersion: (sid: string) => this.runtime.sessionTurnRepo.getTurnVersion(sid),
        getRunAggregateVersion: (rid: string) => this.runtime.taskRunsRepo.findById(rid)?.aggregateVersion ?? null,
        computeStateFingerprint: (rid: string, sid: string) => this.runtime.orchestrationSnapshotService.computeStateFingerprint(rid, sid),
      };

      const promptText = getContinuationPrompt(transition.reasonCode, {
        prohibitedActionFingerprint: transition.prohibitedActionFingerprint,
        blockerReason: transition.blockerReason,
      });

      const internalMessageId = this.newInternalPromptMessageId();
      const dispatchIdentity = this.continuationDispatcher.computeTokenIdentity(token);
      const dispatchRes = await this.continuationDispatcher.dispatch(token, {
        statePort,
        client: this.client,
        promptText,
        messageId: internalMessageId,
        beforeNativeDispatch: () => this.reserveInternalPrompt({
          sessionId: sessionID,
          messageId: internalMessageId,
          provenance: "FLOWDECK_CONTINUATION",
          dispatchIdentity,
        }),
      });

      if (dispatchRes.dispatched) {
        noteInternalContinuation(sessionID);
      }
    }
  }

  /**
   * Shared cancellation barrier for REPLACE and material MODIFY/reclassification.
   */
  private async cancelAndCheckReplacementSafety(
    runId: string,
    reason: string
  ): Promise<"SAFE_TO_REPLACE" | "TERMINATION_PENDING" | "TERMINAL_RACE"> {
    try {
      await this.runtime.services.runService.cancelRun(runId, reason);
    } catch (err: any) {
      if (err?.code === ErrorCodes.RUN_IN_TERMINAL_STATE) {
        // Run already in terminal state; check children below
      } else {
        console.error("[FlowDeckLifecycleAdapter] cancelRun error in replacement barrier:", err);
      }
    }

    const diag = this.runtime.childExecutionLifecycleService.getDiagnosticsForRun(runId);
    const hasUnconfirmedChild = diag.childExecutions?.some(
      c => !c.nativeTerminationConfirmed && (c.status === "running" || c.status === "queued")
    );

    if (hasUnconfirmedChild) {
      return "TERMINATION_PENDING";
    }

    return "SAFE_TO_REPLACE";
  }

  /**
   * Drains and actively resumes all deferred replacements that are safe to resume:
   * (i.e. status is pending_termination and the prior run has no pending native child terminations).
   * Called during startup recovery and after session termination events.
   */
  async drainSafeDeferredReplacements(): Promise<number> {
    if (this.disposed || !this.runtime.deferredReplacementRepo) return 0;
    const pendingList = this.runtime.deferredReplacementRepo.listPendingReadyForResume();
    let resumedCount = 0;

    for (const deferred of pendingList) {
      if (this.disposed) break;
      const diag = this.runtime.childExecutionLifecycleService?.getDiagnosticsForRun(deferred.oldRunId);
      if (!diag?.currentTerminationPending) {
        const claimed = this.runtime.deferredReplacementRepo.claimForResume(deferred.id);
        if (claimed) {
          await this.resumeDeferredReplacement(deferred);
          resumedCount++;
        }
      }
    }

    return resumedCount;
  }

  /**
   * Resumes a single claimed deferred replacement:
   * - Sets route decision in memory
   * - FAST_DIRECT: performs durable handoff (resuming -> handoff_pending -> resumed)
   * - Orchestrated: syncOrchestrationRun -> markResumed -> native promptAsync injection with dedicated prompt contract
   */
  async resumeDeferredReplacement(deferred: DeferredReplacementRecord): Promise<void> {
    if (this.disposed) return;
    const current = this.runtime.deferredReplacementRepo.findById(deferred.id);
    if (!current || current.status !== "resuming") {
      return;
    }

    const parentSessionId = current.parentSessionId;
    markRouteInactive(parentSessionId);
    const userTurnVersion = this.runtime.sessionTurnRepo.getTurnVersion(parentSessionId);

    if (current.routingDecision.executionClass === "FAST_DIRECT") {
      const marked = this.runtime.deferredReplacementRepo.markHandoffPending(current.id);
      if (!marked) {
        const refreshed = this.runtime.deferredReplacementRepo.findById(current.id);
        if (refreshed?.status === "cancelled" || refreshed?.status === "superseded" || refreshed?.status === "blocked") {
          return;
        }
      }

      const taskId = "task-" + randomUUID();
      setRouteDecision(parentSessionId, taskId, current.routingDecision, current.effectiveGoal, current.messageHash);
      this.pendingFastDirectTurns.set(parentSessionId, {
        sessionID: parentSessionId,
        taskId,
        messageHash: current.messageHash,
        messageID: current.correlationId,
        turnVersion: userTurnVersion,
      });

      if (this.testHandoffFaultHook) {
        await this.testHandoffFaultHook("FAST_DIRECT", current);
      }
      if (this.disposed) return;

      // Re-verify eligibility before dispatch
      const activeCheck = this.runtime.deferredReplacementRepo.findById(current.id);
      if (!activeCheck || activeCheck.status === "cancelled" || activeCheck.status === "superseded" || activeCheck.status === "blocked") {
        return;
      }

      const token: ContinuationToken = {
        runId: "fast_direct:" + current.id,
        sessionId: parentSessionId,
        userTurnVersion,
        runAggregateVersion: 1,
        transitionReason: "PROGRESS_CONFIRMED",
        currentWorkItemId: "fast_direct:" + current.id,
        stateFingerprint: "deferred_resume:" + current.id,
        identityKey: "deferred:" + current.id,
      };

      noteInternalContinuation(parentSessionId);
      const internalMessageId = this.newInternalPromptMessageId();
      const dispatchIdentity = this.continuationDispatcher.computeTokenIdentity(token);
      const promptText = `[Continuation] Resume the deferred user goal now that prior native child termination has been confirmed: "${current.effectiveGoal}". Do not repeat the previous cancelled work.`;

      const dispatchRes = await this.continuationDispatcher.dispatch(token, {
        client: this.client,
        promptText,
        messageId: internalMessageId,
        beforeNativeDispatch: () => this.reserveInternalPrompt({
          sessionId: parentSessionId,
          messageId: internalMessageId,
          provenance: "FLOWDECK_RECOVERY",
          dispatchIdentity,
        }),
        validateAuthority: () => {
          const fresh = this.runtime.deferredReplacementRepo.findById(current.id);
          if (!fresh) return false;
          if (fresh.id !== current.id) return false;
          if (fresh.status !== "handoff_pending" && fresh.status !== "resuming") return false;
          if (fresh.messageHash !== current.messageHash) return false;
          return true;
        },
      });

      if (dispatchRes.dispatched) {
        this.runtime.deferredReplacementRepo.markResumed(current.id, undefined);
      } else if (dispatchRes.reason === "dispatch_outcome_unknown") {
        this.runtime.deferredReplacementRepo.markHandoffOutcomeUnknown(current.id);
      } else if (dispatchRes.reason === "native_dispatch_failed") {
        const dispatchRow = this.runtime.db.query(
          "SELECT status, attempt_count FROM continuation_dispatches WHERE identity = ?"
        ).get(this.continuationDispatcher.computeTokenIdentity(token)) as { status: string; attempt_count: number } | null;
        if (dispatchRow?.status === "blocked" || (dispatchRow?.status === "failed" && dispatchRow.attempt_count >= 2)) {
          this.runtime.deferredReplacementRepo.markBlocked(current.id);
        }
      }
    } else {
      let replacement: Run | null = null;
      if (current.replacementRunId) {
        replacement = await this.runtime.services.runRepo.findById(current.replacementRunId);
      }
      if (!replacement && current.correlationId) {
        replacement = await this.runtime.services.runRepo.findByCorrelationId(current.correlationId);
      }
      if (!replacement) {
        const taskId = "task-" + randomUUID();
        replacement = await this.syncOrchestrationRun(
          taskId,
          parentSessionId,
          current.agentId,
          current.routingDecision,
          current.effectiveGoal,
          current.messageHash,
          current.correlationId ?? ("deferred-" + taskId)
        );
      }

      if (!replacement) {
        return;
      }

      // Re-check if user cancelled / superseded during Run creation
      const refreshed = this.runtime.deferredReplacementRepo.findById(current.id);
      if (!refreshed || refreshed.status === "cancelled" || refreshed.status === "superseded" || refreshed.status === "blocked") {
        return;
      }

      const marked = this.runtime.deferredReplacementRepo.markHandoffPending(current.id, replacement.id);
      if (!marked) {
        const latest = this.runtime.deferredReplacementRepo.findById(current.id);
        if (latest?.status === "cancelled" || latest?.status === "superseded" || latest?.status === "blocked") {
          return;
        }
      }

      if (this.testHandoffFaultHook) {
        await this.testHandoffFaultHook("ORCHESTRATED", current, replacement);
      }
      if (this.disposed) return;

      // Re-verify eligibility before dispatch
      const activeCheck = this.runtime.deferredReplacementRepo.findById(current.id);
      if (!activeCheck || activeCheck.status === "cancelled" || activeCheck.status === "superseded" || activeCheck.status === "blocked") {
        return;
      }

      const token: ContinuationToken = {
        runId: replacement.id,
        sessionId: parentSessionId,
        userTurnVersion,
        runAggregateVersion: 1,
        transitionReason: "PROGRESS_CONFIRMED",
        currentWorkItemId: "root:" + replacement.id,
        stateFingerprint: "deferred_resume:" + current.id,
        identityKey: "deferred:" + current.id,
      };

      noteInternalContinuation(parentSessionId);
      const internalMessageId = this.newInternalPromptMessageId();
      const dispatchIdentity = this.continuationDispatcher.computeTokenIdentity(token);
      const promptText = `[Continuation] Resume the deferred user goal now that prior native child termination has been confirmed: "${current.effectiveGoal}". Use the already persisted FlowDeck routing/run state. Do not repeat the previous cancelled work.`;

      const dispatchRes = await this.continuationDispatcher.dispatch(token, {
        client: this.client,
        promptText,
        messageId: internalMessageId,
        beforeNativeDispatch: () => this.reserveInternalPrompt({
          sessionId: parentSessionId,
          messageId: internalMessageId,
          provenance: "FLOWDECK_RECOVERY",
          dispatchIdentity,
        }),
        validateAuthority: () => {
          const fresh = this.runtime.deferredReplacementRepo.findById(current.id);
          if (!fresh) return false;
          if (fresh.id !== current.id) return false;
          if (fresh.status !== "handoff_pending" && fresh.status !== "resuming") return false;
          if (fresh.messageHash !== current.messageHash) return false;
          return true;
        },
      });

      if (dispatchRes.dispatched) {
        this.runtime.deferredReplacementRepo.markResumed(current.id, replacement.id);
      } else if (dispatchRes.reason === "dispatch_outcome_unknown") {
        this.runtime.deferredReplacementRepo.markHandoffOutcomeUnknown(current.id);
      } else if (dispatchRes.reason === "native_dispatch_failed") {
        const dispatchRow = this.runtime.db.query(
          "SELECT status, attempt_count FROM continuation_dispatches WHERE identity = ?"
        ).get(this.continuationDispatcher.computeTokenIdentity(token)) as { status: string; attempt_count: number } | null;
        if (dispatchRow?.status === "blocked" || (dispatchRow?.status === "failed" && dispatchRow.attempt_count >= 2)) {
          this.runtime.deferredReplacementRepo.markBlocked(current.id);
        }
      }
    }
  }

  async onSessionDeleted(sessionID: string) {
    if (this.disposed) return;
    this.pendingFastDirectTurns.delete(sessionID);
    clearRouteDecision(sessionID);
    this.runtime.internalMessageProvenanceRepo?.deleteForSession(sessionID);

    // If deleted session belongs to a child execution where cancellation was requested / pending
    const childRec = this.runtime.childExecutionLifecycleService?.getChildExecution({ childSessionId: sessionID });
    if (childRec) {
      if ((childRec.cancelRequested || childRec.status === "cancelled") && !childRec.nativeTerminationConfirmed) {
        await this.runtime.childExecutionLifecycleService.confirmNativeTermination({ childSessionId: sessionID });
      }

      // Check and drain any pending deferred replacements ready to resume.
      // The guard prevents a terminal teardown from re-entering persistence after
      // an awaited native-termination confirmation.
      if (!this.disposed) {
        await this.drainSafeDeferredReplacements();
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pendingFastDirectTurns.clear();
    // Do not close SQLite while adapter-owned deferred recovery is still using
    // it. This is a terminal lifecycle barrier, not a retry or timing heuristic.
    await this.awaitLifecycleQuiescence();
  }
}
