import { IdempotencyRecord } from "../domain/idempotency-record"
import { type IdempotencyRepository, type ReservationResult } from "../ports/idempotency-repository"
import type { Instant } from "../../common/types"

export class InMemoryIdempotencyRepository implements IdempotencyRepository {
  private readonly records = new Map<string, IdempotencyRecord>()

  private scopedKey(commandType: string, taskRunId: string, idempotencyKey: string): string {
    return `${commandType}:${taskRunId}:${idempotencyKey}`
  }

  async tryReserve(
    commandType: string, taskRunId: string, idempotencyKey: string,
    payloadHash: string, createdAt: Instant,
  ): Promise<ReservationResult> {
    const key = this.scopedKey(commandType, taskRunId, idempotencyKey)
    const existing = this.records.get(key)

    if (existing) {
      if (existing.status === "completed") {
        if (existing.payloadHash === payloadHash) {
          return { status: "completed", record: existing }
        }
        return { status: "conflict", record: existing, expectedPayloadHash: existing.payloadHash, actualPayloadHash: payloadHash }
      }
      if (existing.status === "reserved") {
        return { status: "in_progress", record: existing }
      }
      // released — allow re-reservation
      const record = new IdempotencyRecord({
        id: key, commandType, taskRunId, idempotencyKey,
        payloadHash, status: "reserved", createdAt,
      })
      this.records.set(key, record)
      return { status: "acquired", record }
    }

    // New reservation
    const record = new IdempotencyRecord({
      id: key, commandType, taskRunId, idempotencyKey,
      payloadHash, status: "reserved", createdAt,
    })
    this.records.set(key, record)
    return { status: "acquired", record }
  }

  async completeReservation(
    commandType: string, taskRunId: string, idempotencyKey: string,
    resultType: string, resultId: string, completedAt: Instant,
  ): Promise<void> {
    const key = this.scopedKey(commandType, taskRunId, idempotencyKey)
    const existing = this.records.get(key)
    if (!existing) throw new Error(`No reservation for key ${key}`)
    if (existing.status !== "reserved") throw new Error(`Cannot complete reservation in status "${existing.status}"`)
    const completed = existing.complete(resultType, resultId, completedAt)
    this.records.set(key, completed)
  }

  async releaseReservation(commandType: string, taskRunId: string, idempotencyKey: string): Promise<void> {
    const key = this.scopedKey(commandType, taskRunId, idempotencyKey)
    const existing = this.records.get(key)
    if (!existing || existing.status !== "reserved") return
    const released = existing.release()
    this.records.set(key, released)
  }

  async getByScopedKey(commandType: string, taskRunId: string, idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    return this.records.get(this.scopedKey(commandType, taskRunId, idempotencyKey))
  }

  clear(): void { this.records.clear() }
}
