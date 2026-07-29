import type { IdempotencyRecord } from "../domain/idempotency-record"

export interface IdempotencyRepository {
  /** Reserves an idempotency key. Returns undefined if key already exists. */
  tryReserve(commandType: string, taskRunId: string, idempotencyKey: string, payloadHash: string, resultType: string, resultId: string, createdAt: Date): Promise<IdempotencyRecord | undefined>

  /** Returns the existing record for a scoped key, or undefined. */
  getByScopedKey(commandType: string, taskRunId: string, idempotencyKey: string): Promise<IdempotencyRecord | undefined>

  /** Returns the payload hash for an existing key. */
  getPayloadHash(commandType: string, taskRunId: string, idempotencyKey: string): Promise<string | undefined>
}
