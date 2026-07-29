import type { IEventBus } from "../services/ports";
import { OrchestrationEventType } from "../types";
import type { SseManager } from "./sse-manager";
import type { WebSocketManager } from "./websocket-manager";
import type { EventSubscriptionManager } from "./event-subscription";

export function wireLiveUpdates(
  eventBus: IEventBus,
  sseManager: SseManager,
  wsManager: WebSocketManager,
  subscriptionManager: EventSubscriptionManager,
): () => void {
  const unsubscribe = eventBus.subscribeAll(async (event) => {
    // Broadcast to SSE clients
    sseManager.broadcast(event);

    // Broadcast to WebSocket clients
    wsManager.broadcast(event);

    // Deliver via subscription manager
    await subscriptionManager.deliver(event);
  });

  return unsubscribe;
}

// ── Live update endpoint helpers ─────────────────────────────────────────

export function createLiveRunUpdates(sseManager: SseManager) {
  return {
    onRunProgress(runId: string, progressPercent: number, stage: string, status: string): void {
      sseManager.broadcast({
        id: `run-${Date.now()}`,
        type: OrchestrationEventType.RUN_PROGRESS as any,
        timestamp: new Date().toISOString(),
        correlationId: runId,
        runId,
        data: { progressPercent, stage, status, updatedAt: new Date().toISOString() },
        metadata: {},
      });
    },

    onAssignmentUpdate(assignmentId: string, runId: string, status: string): void {
      sseManager.broadcast({
        id: `assignment-${Date.now()}`,
        type: "assignment.progress" as any,
        timestamp: new Date().toISOString(),
        correlationId: assignmentId,
        runId,
        assignmentId,
        data: { status, updatedAt: new Date().toISOString() },
        metadata: {},
      });
    },

    onVerificationUpdate(verificationId: string, runId: string, status: string): void {
      sseManager.broadcast({
        id: `verification-${Date.now()}`,
        type: "verification.progress" as any,
        timestamp: new Date().toISOString(),
        correlationId: verificationId,
        runId,
        data: { status, updatedAt: new Date().toISOString() },
        metadata: {},
      });
    },
  };
}
