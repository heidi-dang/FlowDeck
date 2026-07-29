import { IdempotencyRecord } from "../domain/idempotency-record"
import type { IdempotencyRepository } from "../ports/idempotency-repository"

export class InMemoryIdempotencyRepository implements IdempotencyRepository {
  private readonly records = new Map<string, IdempotencyRecord>()

  private scopedKey(commandType: string, taskRunId: string, idempotencyKey: string): string {
    return `${commandType}:${taskRunId}:${idempotencyKey}`
  }

  async tryReserve(commandType: string, taskRunId: string, idempotencyKey: string, payloadHash: string, resultType: string, resultId: string, createdAt: Date): Promise<IdempotencyRecord | undefined> {
    const key = this.scopedKey(commandType, taskRunId, idempotencyKey)
    if (this.records.has(key)) return undefined
    const record = new IdempotencyRecord({ id: key, commandType, taskRunId, idempotencyKey, payloadHash, resultType, resultId, createdAt })
    this.records.set(key, record)
    return record
  }

  async getByScopedKey(commandType: string, taskRunId: string, idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    return this.records.get(this.scopedKey(commandType, taskRunId, idempotencyKey))
  }

  async getPayloadHash(commandType: string, taskRunId: string, idempotencyKey: string): Promise<string | undefined> {
    const record = this.records.get(this.scopedKey(commandType, taskRunId, idempotencyKey))
    return record?.payloadHash
  }

  clear(): void { this.records.clear() }
}
