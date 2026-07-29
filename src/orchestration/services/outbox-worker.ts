import type { IOutboxRepository, IEventBus } from "./ports";
import { OutboxStatus } from "../types/outbox";

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
      const pendingEntries = await this.outboxRepo.findMany(
        { status: OutboxStatus.PENDING },
        { page: 1, pageSize: this.batchSize },
      );

      for (const entry of pendingEntries.data) {
        try {
          // Reconstruct event payload
          const event = {
            id: entry.eventId,
            type: entry.eventType,
            correlationId: entry.correlationId,
            causationId: entry.causationId ?? entry.correlationId,
            aggregateId: entry.aggregateId ?? "",
            aggregateType: "orchestration",
            aggregateVersion: 1,
            timestamp: entry.createdAt,
            payload: entry.payload,
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
          const newStatus = attemptCount >= maxRetries ? OutboxStatus.FAILED : OutboxStatus.PENDING;

          await this.outboxRepo.update(entry.id, {
            status: newStatus,
            attemptCount,
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
