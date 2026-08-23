import { randomUUID } from "node:crypto";
import type { ProductionOrchestrationRuntime } from "../orchestration/composition";
import {
  shouldPreserveRoute,
  setRouteDecision,
  clearRouteDecision,
  noteInternalContinuation,
  getRouteDecision,
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

      // Hydrate authoritative session route from SQLite if not currently in memory
      await this.hydrateSessionRoute(input.sessionID);

      const { preserve } = shouldPreserveRoute(input.sessionID, msgHash);
      if (!preserve) {
        // Genuine new user instruction
        const decision = classifyTask(text, { hasExplicitDomainSignal: false });
        const correlationId = input.messageID || randomUUID();
        const taskId = "task-" + randomUUID();
        setRouteDecision(input.sessionID, taskId, decision, text, msgHash);
        await this.syncOrchestrationRun(taskId, input.sessionID, input.agent ?? "heidi", decision, text, msgHash, correlationId);
      } else {
        noteInternalContinuation(input.sessionID);
      }
    }
  }

  /**
   * Hydrates route state from authoritative SQLite persistence after a process restart or session resume.
   */
  async hydrateSessionRoute(sessionID: string): Promise<void> {
    if (getRouteDecision(sessionID)) return; // Already present in route projection cache

    const sessionRow = this.runtime.sessionRepo.findById(sessionID);
    if (!sessionRow) return;

    const run = await this.runtime.services.runRepo.findById(sessionRow.runId);
    if (!run || isTerminalRunStatus(run.status)) return;

    const routingDecision = this.runtime.routingDecisionRepository.getLatestDecisionForRun(run.id);
    if (!routingDecision) {
      // Diagnostic: run exists but has no authoritative routing decision persisted
      return;
    }

    const { decision, goal, lastUserMessageHash } = reconstructRouterDecision(routingDecision);
    setRouteDecision(sessionID, run.id, decision, goal, lastUserMessageHash);
  }

  /**
   * Persists Run, canonical RoutingDecision, and binds session affinity.
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
    // FAST_DIRECT bypasses heavy persistence overhead for minimal latency
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

      // Authoritative routing persistence
      const canonicalRouting = buildCanonicalRoutingDecision({
        runId: run.id,
        decision,
        goal,
        lastUserMessageHash: msgHash,
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
    // Captures raw execution before tool runs
  }

  async onToolExecuteAfter(
    input: { tool: string; sessionID: string; callID: string; args: any },
    _output: { output: string; metadata: any }
  ) {
    if (this.disposed) return;
    // Track session tool metrics authoritatively
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

  async onSessionIdle(_sessionID: string) {
    // Continuation Policy evaluation (handled in future phase)
  }

  async onSessionError(_sessionID: string, _error: any) {
    // Session error handling
  }

  async onSessionDeleted(sessionID: string) {
    clearRouteDecision(sessionID);
  }

  dispose(): void {
    this.disposed = true;
  }
}
