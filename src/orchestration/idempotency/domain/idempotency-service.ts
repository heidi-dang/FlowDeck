/**
 * Idempotency service — reservation-first API.
 * Timestamps come from the caller (injected clock), never generated internally.
 */

import { type IdempotencyRepository, type ReservationResult } from "../ports/idempotency-repository"
import { hashFingerprint } from "../../common/canonical-hash"
import type { Instant } from "../../common/types"

export class IdempotencyService {
  constructor(private readonly repository: IdempotencyRepository) {}

  async tryReserve(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
    fingerprint: Record<string, unknown>,
    now: Instant,
  ): Promise<ReservationResult & { payloadHash: string }> {
    const payloadHash = hashFingerprint(fingerprint)
    const result = await this.repository.tryReserve(commandType, taskRunId, idempotencyKey, payloadHash, now)
    return { ...result, payloadHash }
  }

  async complete(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
    resultType: string,
    resultId: string,
    now: Instant,
  ): Promise<void> {
    await this.repository.completeReservation(commandType, taskRunId, idempotencyKey, resultType, resultId, now)
  }

  async release(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.repository.releaseReservation(commandType, taskRunId, idempotencyKey)
  }
}
