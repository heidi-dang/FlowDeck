/**
 * Idempotency service — reservation-first API.
 * The command sequence must begin with tryReserve.
 * No domain evaluation happens before reservation.
 */

import { type IdempotencyRepository, type ReservationResult } from "../ports/idempotency-repository"
import { hashFingerprint } from "../../common/canonical-hash"

export class IdempotencyService {
  constructor(private readonly repository: IdempotencyRepository) {}

  /**
   * Attempt to acquire an idempotency reservation.
   * Must be called first, before any domain mutation.
   *
   * Returns:
   *   acquired → caller may proceed with command execution
   *   completed → exact replay available
   *   in_progress → another command holds the key
   *   conflict → same key, different payload
   */
  async tryReserve(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
    fingerprint: Record<string, unknown>,
  ): Promise<ReservationResult & { payloadHash: string }> {
    const payloadHash = hashFingerprint(fingerprint)
    const result = await this.repository.tryReserve(commandType, taskRunId, idempotencyKey, payloadHash, new Date().toISOString() as any)
    return { ...result, payloadHash }
  }

  /**
   * Complete a reservation with result linkage.
   * Must be called after successful command execution, before commit.
   */
  async complete(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
    resultType: string,
    resultId: string,
  ): Promise<void> {
    await this.repository.completeReservation(commandType, taskRunId, idempotencyKey, resultType, resultId, new Date().toISOString() as any)
  }

  /**
   * Release a reservation (rollback).
   * Must be called on failure before transaction rollback completes.
   */
  async release(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.repository.releaseReservation(commandType, taskRunId, idempotencyKey)
  }
}
