import type { ProductionOrchestrationRuntime } from "../orchestration/composition";
import { shouldPreserveRoute, setRouteDecision, clearRouteDecision, noteInternalContinuation } from "../services/heidi-route-state";
import { classifyTask } from "../services/heidi-fast-router";
import type { Event, UserMessage, Part, TextPart } from "@opencode-ai/sdk";
import { stableHash } from "../services/heidi-fast-router";
import { checkConvergenceBefore, checkConvergenceAfter } from "../services/convergence-guard";

export class FlowDeckLifecycleAdapter {
  constructor(
    private readonly directory: string,
    private readonly runtime: ProductionOrchestrationRuntime,
  ) {}

  async onChatMessage(
    input: { sessionID: string; agent?: string; messageID?: string },
    output: { message: UserMessage; parts: Part[] }
  ) {
    if (input.agent === "heidi" || input.agent === "orchestrator") {
      const text = output.parts
        .filter((p): p is TextPart => p.type === "text")
        .map(p => p.text)
        .join("\n");
        
      const msgHash = stableHash(text);
      const { preserve } = shouldPreserveRoute(input.sessionID, msgHash);
      if (!preserve) {
        // Genuine new user instruction
        const decision = classifyTask(text, { hasExplicitDomainSignal: false });
        const newTaskId = "task-" + Date.now();
        setRouteDecision(input.sessionID, newTaskId, decision, text, msgHash);
        await this.syncOrchestrationRun(newTaskId, input.sessionID, "heidi", decision.executionClass);
      } else {
        noteInternalContinuation(input.sessionID);
      }
    }
  }

  private async syncOrchestrationRun(taskId: string, sessionID: string, agentId: string, executionClass: string) {
    // Only persist a run if it warrants heavy orchestration.
    if (executionClass === "FAST_DIRECT") return;

    try {
      await this.runtime.services.runService.createRun({
        runType: executionClass,
        correlationId: taskId,
        sessionId: sessionID,
        agentId,
        metadata: { taskId }
      });
    } catch (err) {
      console.error("[FlowDeckLifecycleAdapter] syncOrchestrationRun failed:", err);
    }
  }

  async onToolExecuteBefore(
    input: { tool: string; sessionID: string; callID: string; args?: any }
  ) {
    checkConvergenceBefore(input.sessionID, input.tool, input.args);
  }

  async onToolExecuteAfter(
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: { output: string; metadata: any }
  ) {
    checkConvergenceAfter(input.sessionID, input.tool, input.args, output.output);
  }

  async onEvent(event: Event) {
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
    // Continuation Policy evaluation here
  }

  async onSessionError(_sessionID: string, _error: any) {
    // Error recovery here
  }

  async onSessionDeleted(sessionID: string) {
    clearRouteDecision(sessionID);
  }
}
