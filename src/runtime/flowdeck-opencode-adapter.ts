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
import {
  buildCanonicalRoutingDecision,
  reconstructRouterDecision,
  mapExecutionClassToRunStrategy,
} from "../orchestration/routing/fast-router-adapter";

export class FlowDeckLifecycleAdapter {
  private disposed = false;
  private pendingFastDirectTurnSessions = new Set<string>();

  constructor(
    private readonly directory: string,
    private readonly runtime: ProductionOrchestrationRuntime,
  ) {}

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

      // 1. Check if this is an exact duplicate replay of the previous turn
      if (isDuplicateMessage(input.sessionID, msgHash)) {
        noteInternalContinuation(input.sessionID);
        return;
      }

      // 2. Hydrate/inspect authoritative durable state from SQLite
      const activeRun = await this.resolveActiveRunForSession(input.sessionID);

      if (activeRun) {
        // There is an active, non-terminal Run in SQLite.
        // User message during active non-terminal work is preserved as a continuation.
        noteInternalContinuation(input.sessionID);
        return;
      }

      // 3. No active non-terminal Run exists (either terminal, FAST_DIRECT completed, or first turn).
      // Genuine new user instruction → Classify independently.
      const decision = classifyTask(text, { hasExplicitDomainSignal: false });
      const correlationId = input.messageID || randomUUID();
      const taskId = "task-" + randomUUID();

      setRouteDecision(input.sessionID, taskId, decision, text, msgHash);

      if (decision.executionClass === "FAST_DIRECT") {
        // Mark ephemeral FAST_DIRECT turn active for this session
        this.pendingFastDirectTurnSessions.add(input.sessionID);
      } else {
        await this.syncOrchestrationRun(taskId, input.sessionID, input.agent ?? "heidi", decision, text, msgHash, correlationId);
      }
    }
  }

  /**
   * Resolves whether the session has an active non-terminal Run in SQLite.
   * Also hydrates route state if found.
   */
  async resolveActiveRunForSession(sessionID: string) {
    const sessionRow = this.runtime.sessionRepo.findById(sessionID);
    if (!sessionRow) {
      // Ephemeral FAST_DIRECT check: if completed turn boundary passed, it's not active
      if (this.pendingFastDirectTurnSessions.has(sessionID)) {
        return null;
      }
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

  /**
   * Hydrates route state from authoritative SQLite persistence after a process restart or session resume.
   */
  async hydrateSessionRoute(sessionID: string): Promise<void> {
    await this.resolveActiveRunForSession(sessionID);
  }

  /**
   * Persists Run, canonical RoutingDecision with real assessment, and binds session affinity.
   */
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
        metadata: { taskId, goal, lastUserMessageHash: msgHash }
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
        status: "running"
      });
    } catch (err) {
      console.error("[FlowDeckLifecycleAdapter] syncOrchestrationRun failed:", err);
    }
  }

  async onToolExecuteBefore(
    _input: { tool: string; sessionID: string; callID: string; args?: any }
  ) {
    if (this.disposed) return;
  }

  async onToolExecuteAfter(
    input: { tool: string; sessionID: string; callID: string; args: any },
    _output: { output: string; metadata: any }
  ) {
    if (this.disposed) return;
    if (input.sessionID) {
      try {
        this.runtime.sessionRepo.incrementMetrics(input.sessionID, 1, 0);
      } catch {
        // Safe fail
      }
    }
  }

  async onEvent(event: Event) {
    if (this.disposed) return;
    if (event.type === "session.idle") {
      await this.onSessionIdle(event.properties.sessionID);
    } else if (event.type === "session.error") {
      await this.onSessionError(event.properties.sessionID || "unknown", (event.properties as any).error);
    } else if (event.type === "session.deleted") {
      const sid = (event.properties as any).info?.id || (event.properties as any).sessionID || "unknown";
      await this.onSessionDeleted(sid);
    }
  }

  async onSessionIdle(sessionID: string) {
    // When session goes idle, any ephemeral FAST_DIRECT turn is completed
    if (sessionID && this.pendingFastDirectTurnSessions.has(sessionID)) {
      this.pendingFastDirectTurnSessions.delete(sessionID);
      markRouteInactive(sessionID);
    }
  }

  async onSessionError(_sessionID: string, _error: any) {
    // Session error handling
  }

  async onSessionDeleted(sessionID: string) {
    this.pendingFastDirectTurnSessions.delete(sessionID);
    clearRouteDecision(sessionID);
  }

  dispose(): void {
    this.disposed = true;
    this.pendingFastDirectTurnSessions.clear();
  }
}
