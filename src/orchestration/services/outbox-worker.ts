/**
 * Outbox worker — polls pending outbox entries, reconstructs events,
 * publishes through the event bus, and marks delivered/failed.
 * Malformed entries are moved to dead-letter state (failed).
 */

import type { IOutboxRepository, IEventBus } from "./ports";
import { OutboxStatus } from "../types/outbox";
import type { OrchestrationEvent } from "../types/events";
import { EVENT_VERSION } from "../types/events";

export class OutboxWorker {
  private isProcessing = false;
  private intervalTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly outboxRepo: IOutboxRepository,
    private readonly eventBus: IEventBus,
    private readonly batchSize: number = 20,
  ) {}

  /** Process a single batch of pending outbox entries */
  async processBatch(): Promise<{ processed: number; failed: number }> {
    if (this.isProcessing) return { processed: 0, failed: 0 };
    this.isProcessing = true;

    let processed = 0;
    let failed = 0;

    try {
      const pendingEntries = await this.outboxRepo.findPending();

      for (const entry of pendingEntries) {
        try {
          // Validate persisted JSON before event delivery
          const payload = typeof entry.payload === "string"
            ? JSON.parse(entry.payload)
            : entry.payload;

          const event: OrchestrationEvent = {
            id: entry.eventId,
            type: entry.eventType,
            eventVersion: EVENT_VERSION,
            timestamp: entry.createdAt,
            correlationId: entry.correlationId,
            causationId: entry.causationId ?? entry.correlationId,
            aggregateId: entry.aggregateId ?? "",
            aggregateVersion: 1,
            data: (payload as Record<string, unknown>) ?? {},
            metadata: {},
          };

          await this.eventBus.publish(event);

          await this.outboxRepo.update(entry.id, {
            status: OutboxStatus.DELIVERED,
            deliveredAt: new Date().toISOString(),
          });
          processed++;
        } catch (err) {
          failed++;
          const attemptCount = (entry.attemptCount ?? 0) + 1;
          const maxRetries = entry.maxRetries ?? 3;
          // Move to failed (dead-letter) state after exhausting retries
          const newStatus = attemptCount >= maxRetries ? OutboxStatus.FAILED : OutboxStatus.PENDING;

          await this.outboxRepo.update(entry.id, {
            status: newStatus,
            attemptCount,
            retryCount: attemptCount,
            lastError: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return { processed, failed };
  }

  /** Start periodic background outbox processing */
  start(intervalMs: number = 1000): void {
    if (this.intervalTimer) return;
    this.intervalTimer = setInterval(() => {
      this.processBatch().catch(() => {});
    }, intervalMs);
  }

  /** Stop background processing */
  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
  }
}