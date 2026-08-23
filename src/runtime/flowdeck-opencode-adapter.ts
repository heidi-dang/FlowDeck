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
import { classifyTask, type RouterDecision, stableHash } from "../services/heidi-fast-router";
import type { Event, UserMessage, Part, TextPart } from "@opencode-ai/sdk";
import { isTerminalRunStatus } from "../orchestration/types/runs";
import { ErrorCodes } from "../orchestration/types/errors";
import {
  buildCanonicalRoutingDecision,
  reconstructRouterDecision,
  mapExecutionClassToRunStrategy,
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
import { ContinuationDispatcher, type ContinuationToken } from "../orchestration/services/continuation-policy";

export class FlowDeckLifecycleAdapter implements NativeChildControlPort {
  private disposed = false;
  private turnVersionCounter = 0;
  private pendingFastDirectTurns = new Map<string, PendingFastDirectTurn>();
  private preToolRepositoryFingerprints = new Map<string, string>();
  private inFlightAttempts = new Map<string, { runId: string; assignmentId: string; attemptNumber: number; preStateFingerprint: string; actionFingerprint: string; startedAt: string }>();
  private continuationDispatcher: ContinuationDispatcher;

  constructor(
    private readonly directory: string,
    private readonly runtime: ProductionOrchestrationRuntime,
    private client?: any,
  ) {
    this.continuationDispatcher = new ContinuationDispatcher(this.runtime.db);
    this.runtime.childExecutionLifecycleService.setControlPort(this);
  }

  getClient(): any {
    return this.client;
  }

  setClient(client: any): void {
    if (client) {
      this.client = client;
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

  private getPathFingerprint(relPath: string): string {
    return getMutationTargetFingerprint(this.directory, [relPath]);
  }

  async onChatMessage(
    input: { sessionID: string; agent?: string; messageID?: string },
    output: { message: UserMessage; parts: Part[] }
  ) {
    if (this.disposed) return;
    if (input.agent === "heidi" || input.agent === "orchestrator" || !input.agent) {
      const text = output.parts
        .filter((p): p is TextPart => p.type === "text")
        .map(p => p.text)
        .join("\n");

      if (!text.trim()) return;

      const msgHash = stableHash(text);
      const _currentTurn = this.runtime.sessionTurnRepo.incrementTurnVersion({
        sessionId: input.sessionID,
        messageId: input.messageID,
        messageHash: msgHash,
      });

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

            // Material reclassification -> cancel active Run A through canonical path then start Run B
            try {
              await this.runtime.services.runService.cancelRun(
                activeRun.id,
                "Superseded by modified user goal requiring reclassification"
              );
            } catch (err: any) {
              if (err?.code !== ErrorCodes.RUN_IN_TERMINAL_STATE) {
                console.error("[FlowDeckLifecycleAdapter] cancelRun error on reclassify:", err);
              }
            }
            markRouteInactive(input.sessionID);

            const taskId = "task-" + randomUUID();
            this.turnVersionCounter += 1;
            const turnVersion = this.turnVersionCounter;

            setRouteDecision(input.sessionID, taskId, modResult.newDecision, modResult.effectiveGoal, msgHash);

            if (modResult.newDecision.executionClass === "FAST_DIRECT") {
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
            markRouteInactive(input.sessionID);
            return;
          }

          case "REPLACE": {
            // Supersede existing active run through canonical cancellation path before classifying replacement
            try {
              await this.runtime.services.runService.cancelRun(
                activeRun.id,
                "Superseded by newer user goal"
              );
            } catch (err: any) {
              if (err?.code !== ErrorCodes.RUN_IN_TERMINAL_STATE) {
                console.error("[FlowDeckLifecycleAdapter] cancelRun error on replace:", err);
              }
            }
            markRouteInactive(input.sessionID);
            break;
          }
        }
      }

      // 2. Check for exact duplicate of ephemeral/initial turn
      if (isDuplicateMessage(input.sessionID, msgHash)) {
        noteInternalContinuation(input.sessionID);
        return;
      }

      // 3. Clear any prior FAST_DIRECT pending turn marker atomically
      this.pendingFastDirectTurns.delete(input.sessionID);

      // 4. Genuine new or replacement user instruction -> classify independently
      const decision = classifyTask(text, { hasExplicitDomainSignal: false });
      const taskId = "task-" + randomUUID();
      this.turnVersionCounter += 1;
      const turnVersion = this.turnVersionCounter;

      setRouteDecision(input.sessionID, taskId, decision, text, msgHash);

      if (decision.executionClass === "FAST_DIRECT") {
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
  ): Promise<void> {
    if (decision.executionClass === "FAST_DIRECT") return;

    try {
      const runStrategy = mapExecutionClassToRunStrategy(decision.executionClass);
      const run = await this.runtime.services.runService.createRun({
        runType: runStrategy,
        correlationId,
        sessionId: sessionID,
        agentId,
        metadata: { taskId, goal, lastUserMessageHash: msgHash },
      });

      // Authoritative routing persistence using real repository assessment
      const canonicalRouting = buildCanonicalRoutingDecision({
        runId: run.id,
        decision,
        goal,
        lastUserMessageHash: msgHash,
        directory: this.directory,
      });
      this.runtime.routingDecisionRepository.saveDecision(canonicalRouting);

      // Bind session -> active run
      this.runtime.sessionRepo.bindActiveRun({
        id: sessionID,
        runId: run.id,
        agentId,
        status: "running",
      });
    } catch (err) {
      console.error("[FlowDeckLifecycleAdapter] syncOrchestrationRun failed:", err);
    }
  }

  async onToolExecuteBefore(
    input: { tool: string; sessionID: string; callID: string; args?: any }
  ) {
    if (this.disposed) return;

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
      const activeRun = await this.resolveActiveRunForSession(input.sessionID);
      if (activeRun) {
        runId = activeRun.id;
        const snapshot = this.runtime.orchestrationSnapshotService.getSnapshot(activeRun.id, input.sessionID);
        assignmentId = snapshot?.currentWorkItemId ?? ("root-" + activeRun.id);
      }
    }

    if (runId && assignmentId) {
      const actionFingerprint = this.runtime.progressObservationService.computeActionFingerprint({
        tool: input.tool,
        args: input.args,
        sessionID: input.sessionID,
      });
      const snapshot = this.runtime.orchestrationSnapshotService.getSnapshot(runId, input.sessionID);
      const preStateFingerprint = (snapshot?.progress.lastRepositoryDelta ?? 0) + ":" + (snapshot?.progress.lastEvidenceDelta ?? 0) + ":" + (snapshot?.progress.noProgressCount ?? 0);

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
        await this.runtime.childExecutionLifecycleService.registerDelegation({
          runId: effectiveRunId,
          parentSessionId: input.sessionID,
          taskCallId: input.callID,
          targetAgent: normalized.targetAgent,
          prompt: normalized.prompt,
          description: normalized.description,
          background: normalized.background,
        });
      }
    }
  }

  async onToolExecuteAfter(
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: { output: string; metadata: any; title?: string }
  ) {
    if (this.disposed) return;
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
    const eventType = (event as any).type;
    const props = ((event as any).properties ?? {}) as any;

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

  async onSessionIdle(sessionID: string) {
    if (this.disposed) return;
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

      const dispatchRes = await this.continuationDispatcher.dispatch(token, {
        statePort,
        client: this.client,
      });

      if (dispatchRes.dispatched) {
        noteInternalContinuation(sessionID);
      }
    }
  }

  async onSessionDeleted(sessionID: string) {
    this.pendingFastDirectTurns.delete(sessionID);
    clearRouteDecision(sessionID);
  }

  dispose(): void {
    this.disposed = true;
    this.pendingFastDirectTurns.clear();
  }
}
