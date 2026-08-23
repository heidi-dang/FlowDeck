import type { ProductionOrchestrationRuntime } from "../orchestration/composition";
import { shouldPreserveRoute, setRouteDecision, clearRouteDecision, noteInternalContinuation, getRouteDecision } from "../services/heidi-route-state";
import { classifyTask, type RouterDecision } from "../services/heidi-fast-router";
import type { Event, UserMessage, Part, TextPart } from "@opencode-ai/sdk";
import { stableHash } from "../services/heidi-fast-router";
import { checkConvergenceBefore, checkConvergenceAfter } from "../services/convergence-guard";
import { isTerminalRunStatus } from "../orchestration/types/runs";

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
      
      // Phase 3: Session Affinity. Restore Route State from DB before deciding to preserve.
      await this.hydrateSessionRoute(input.sessionID);

      const { preserve } = shouldPreserveRoute(input.sessionID, msgHash);
      if (!preserve) {
        // Genuine new user instruction
        const decision = classifyTask(text, { hasExplicitDomainSignal: false });
        const newTaskId = "task-" + Date.now();
        setRouteDecision(input.sessionID, newTaskId, decision, text, msgHash);
        await this.syncOrchestrationRun(newTaskId, input.sessionID, "heidi", decision, text, msgHash);
      } else {
        noteInternalContinuation(input.sessionID);
      }
    }
  }

  private async hydrateSessionRoute(sessionID: string) {
    if (getRouteDecision(sessionID)) return; // Already in memory

    const sessionRow = this.runtime.sessionRepo.findById(sessionID);
    if (!sessionRow) return;

    const run = await this.runtime.services.runRepo.findById(sessionRow.runId);
    if (!run || isTerminalRunStatus(run.status)) return;

    const metadata = run.metadata || {};
    const goal = (metadata.goal as string) || "Restored task";
    const msgHash = (metadata.lastUserMessageHash as string) || "unknown";
    const taskId = (metadata.taskId as string) || run.id;
    
    setRouteDecision(sessionID, taskId, {
      executionClass: run.runType as any,
      reason: "Restored from DB",
      reasonCode: "RESTORED",
      confidence: 1,
      forcedByExplicitSignal: false,
      mcpCompositionCandidate: false,
      codeModeRejectedReason: undefined,
      codeModeTelemetry: {
        codeModeConsidered: true,
        codeModeSelected: false,
        codeModeRejectedReason: undefined
      }
    }, goal, msgHash);
  }

  private async syncOrchestrationRun(taskId: string, sessionID: string, agentId: string, decision: RouterDecision, goal: string, msgHash: string) {
    if (decision.executionClass === "FAST_DIRECT") return;

    try {
      const run = await this.runtime.services.runService.createRun({
        runType: decision.executionClass,
        correlationId: taskId,
        sessionId: sessionID,
        agentId,
        metadata: { taskId, goal, lastUserMessageHash: msgHash }
      });

      // Maintain session affinity metadata. 
      const existing = this.runtime.sessionRepo.findById(sessionID);
      if (!existing) {
        this.runtime.sessionRepo.create({
          id: sessionID,
          runId: run.id,
          agentId
        });
      }
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
