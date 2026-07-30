/**
 * Outbox worker — claims pending outbox entries, reconstructs events,
 * publishes through the event bus, and marks delivered/failed.
 *
 * Features:
 * - Claim-based batch processing (atomic claimNextBatch)
 * - Malformed JSON detection (skips entries with decode errors, moves to FAILED after exhaustion)
 * - Idempotent delivery (checks already-delivered via idempotency key)
 * - Observable errors via optional logger
 */

import type { IOutboxRepository, IEventBus } from "./ports";
import { OutboxStatus } from "../types/outbox";
import type { OrchestrationEvent } from "../types/events";
import { EVENT_VERSION } from "../types/events";

export interface Logger {
  error(message: string): void;
}

export class OutboxWorker {
  private isProcessing = false;
  private intervalTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly outboxRepo: IOutboxRepository,
    private readonly eventBus: IEventBus,
    private readonly batchSize: number = 20,
    private readonly logger?: Logger,
  ) {}

  /** Process a single batch of claimed outbox entries */
  async processBatch(): Promise<{ processed: number; failed: number }> {
    if (this.isProcessing) return { processed: 0, failed: 0 };
    this.isProcessing = true;

    let processed = 0;
    let failed = 0;

    try {
      // 1. Claim a batch atomically
      const claimedEntries = await this.outboxRepo.claimNextBatch(this.batchSize);

      for (const entry of claimedEntries) {
        try {
          // 2. Idempotency check — skip if already delivered
          if (entry.status === OutboxStatus.DELIVERED) {
            processed++;
            continue;
          }

          // 3. Malformed JSON detection — never publish a malformed entry
          if (entry.lastError && isDecodeError(entry.lastError)) {
            failed++;
            const attemptCount = (entry.attemptCount ?? 0) + 1;
            const maxRetries = entry.maxRetries ?? 3;

            if (attemptCount >= maxRetries) {
              await this.outboxRepo.markFailed(entry.id, attemptCount, entry.lastError);
            } else {
              // Increment attempt count, keep as pending for retry detection
              await this.outboxRepo.update(entry.id, {
                attemptCount,
                lastError: entry.lastError,
              });
            }
            continue;
          }

          // 4. Validate and parse payload
          const payload = typeof entry.payload === "string"
            ? JSON.parse(entry.payload)
            : entry.payload;

          const event: OrchestrationEvent = {
            id: entry.eventId,
            type: entry.eventType,
            eventVersion: EVENT_VERSION,
            timestamp: new Date().toISOString(),
            correlationId: entry.correlationId,
            causationId: entry.causationId ?? entry.correlationId,
            aggregateId: entry.aggregateId ?? "",
            aggregateVersion: 1,
            data: (payload as Record<string, unknown>) ?? {},
            metadata: {},
          };

          // 5. Publish event through the bus
          await this.eventBus.publish(event);

          // 6. Mark delivered with idempotency key
          await this.outboxRepo.markDelivered(entry.id, entry.correlationId);
          processed++;
        } catch (err) {
          failed++;
          const attemptCount = (entry.attemptCount ?? 0) + 1;
          const maxRetries = entry.maxRetries ?? 3;
          const errorMessage = err instanceof Error ? err.message : String(err);

          if (attemptCount >= maxRetries) {
            await this.outboxRepo.markFailed(entry.id, attemptCount, errorMessage);
          } else {
            // Keep as pending for retry
            await this.outboxRepo.update(entry.id, {
              attemptCount,
              lastError: errorMessage,
            });
          }
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
      this.processBatch().catch((err) => {
        this.logger?.error(
          `OutboxWorker batch error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
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

/** Detect JSON decode/parse errors in error messages */
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