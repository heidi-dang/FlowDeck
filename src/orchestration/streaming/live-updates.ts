import type { IEventBus } from "../services/ports";
import { OrchestrationEventType } from "../types";
import { createEvent } from "../types/events";
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
      sseManager.broadcast(createEvent(
        OrchestrationEventType.RUN_PROGRESS,
        {
          correlationId: runId,
          runId,
          aggregateId: runId,
          data: { progressPercent, stage, status, updatedAt: new Date().toISOString() },
        },
      ));
    },

    onAssignmentUpdate(assignmentId: string, runId: string, status: string): void {
      sseManager.broadcast(createEvent(
        "assignment.progress",
        {
          correlationId: assignmentId,
          runId,
          assignmentId,
          aggregateId: assignmentId,
          data: { status, updatedAt: new Date().toISOString() },
        },
      ));
    },

    onVerificationUpdate(verificationId: string, runId: string, status: string): void {
      sseManager.broadcast(createEvent(
        "verification.progress",
        {
          correlationId: verificationId,
          runId,
          aggregateId: verificationId,
          data: { status, updatedAt: new Date().toISOString() },
        },
      ));
    },
  };
}
