/**
 * Outbox worker — claims due outbox entries through the durable delivery
 * sink, publishes reconstructed events on the event bus, and records
 * idempotent delivery/failure.
 *
 * The worker uses ONLY the lease-based claim path (IDeliverySink.claimDue):
 *
 * - Lease-based claiming (claimDue) with worker identity + lease expiry
 * - Crash recovery via lease expiry (requeueExpiredLeases)
 * - Idempotent delivery (markDelivered guarded by idempotency key)
 * - Retry accounting (markFailed requeues until maxRetries, then fails)
 * - Malformed JSON detection (never publishes a malformed entry)
 * - Observable errors via optional logger
 */

import type { IDeliverySink, IEventBus } from "./ports";
import type { OrchestrationEvent } from "../types/events";
import { EVENT_VERSION } from "../types/events";

export interface Logger {
  error(message: string): void;
}

export interface OutboxWorkerOptions {
  /** Unique worker identity stamped into delivery leases. */
  workerId?: string;
  /** Max entries claimed per batch. */
  batchSize?: number;
  /** Lease duration in seconds before a claim can be reclaimed by another worker. */
  leaseSeconds?: number;
  logger?: Logger;
}

export class OutboxWorker {
  private isProcessing = false;
  private intervalTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly deliverySink: IDeliverySink,
    private readonly eventBus: IEventBus,
    private readonly options: OutboxWorkerOptions = {},
  ) {}

  get isRunning(): boolean {
    return this.intervalTimer !== undefined;
  }

  private get workerId(): string {
    return this.options.workerId ?? `worker-${process.pid ?? 0}`;
  }

  private get batchSize(): number {
    return this.options.batchSize ?? 20;
  }

  private get leaseSeconds(): number {
    return this.options.leaseSeconds ?? 60;
  }

  /** Process a single batch of due (pending or expired-lease) outbox entries. */
  async processBatch(): Promise<{ processed: number; failed: number }> {
    if (this.isProcessing) return { processed: 0, failed: 0 };
    this.isProcessing = true;

    let processed = 0;
    let failed = 0;

    try {
      // 1. Claim due entries atomically through the lease-based sink path.
      const claimed = await this.deliverySink.claimDue(this.workerId, this.batchSize, this.leaseSeconds);

      for (const record of claimed) {
        try {
          // 2. Safety: never re-deliver an already delivered entry.
          if (record.status === "delivered") {
            processed++;
            continue;
          }

          // 3. Malformed JSON detection — never publish a malformed entry.
          if (record.lastError && isDecodeError(record.lastError)) {
            failed++;
            const attemptCount = (record.attemptCount ?? 0) + 1;
            await this.deliverySink.markFailed(record.id, attemptCount, record.lastError, record.maxRetries ?? 3);
            continue;
          }

          // 4. Validate and parse payload.
          const payload = typeof record.payload === "string"
            ? JSON.parse(record.payload)
            : record.payload;

          const event: OrchestrationEvent = {
            id: record.eventId,
            type: record.eventType,
            eventVersion: EVENT_VERSION,
            timestamp: new Date().toISOString(),
            correlationId: record.correlationId,
            causationId: record.causationId ?? record.correlationId,
            aggregateId: record.aggregateId ?? "",
            aggregateVersion: 1,
            data: (payload as Record<string, unknown>) ?? {},
            metadata: {},
          };

          // 5. Publish event through the bus.
          await this.eventBus.publish(event);

          // 6. Idempotent delivery: already delivered elsewhere counts as
          //    success (the event reached the bus exactly once).
          await this.deliverySink.markDelivered(record.id, record.idempotencyKey ?? record.correlationId);
          processed++;
        } catch (err) {
          failed++;
          const attemptCount = (record.attemptCount ?? 0) + 1;
          const maxRetries = record.maxRetries ?? 3;
          const errorMessage = err instanceof Error ? err.message : String(err);
          await this.deliverySink.markFailed(record.id, attemptCount, errorMessage, maxRetries);
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return { processed, failed };
  }

  /** Start periodic background outbox processing. */
  start(intervalMs: number = 1000): void {
    if (this.intervalTimer) return;
    this.intervalTimer = setInterval(() => {
      this.processBatch().catch((err) => {
        this.options.logger?.error(
          `OutboxWorker batch error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, intervalMs);
  }

  /** Stop background processing. */
  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
  }
}

/** Detect JSON decode/parse errors in error messages. */
function isDecodeError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("decode") ||
    lower.includes("unexpected token") ||
    lower.includes("json") ||
    lower.includes("parse") ||
    lower.includes("malformed") ||
    lower.includes("unexpected end")
  );
}
