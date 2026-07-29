/**
 * Idempotency service — protects commands by scoped key + payload hash.
 * Used by the atomic completion command service.
 */

import { IdempotencyConflictError } from "./errors"
import { type IdempotencyRepository } from "../ports/idempotency-repository"

export class IdempotencyService {
  constructor(private readonly repository: IdempotencyRepository) {}

  /**
   * Checks idempotency for a command.
   * Returns:
   *   - { replayed: true, result } if exact replay
   *   - { replayed: false } if new execution is needed
   *   - throws IdempotencyConflictError if same key, different payload
   */
  async check(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
    payload: unknown,
  ): Promise<{ replayed: boolean; result?: { resultType: string; resultId: string } }> {
    const payloadHash = hashPayload(payload)
    const existing = await this.repository.getByScopedKey(commandType, taskRunId, idempotencyKey)

    if (existing) {
      if (existing.payloadHash === payloadHash) {
        // Same payload — replay existing result
        return { replayed: true, result: { resultType: existing.resultType, resultId: existing.resultId } }
      }
      throw new IdempotencyConflictError(
        `${commandType}:${taskRunId}:${idempotencyKey}`,
        existing.payloadHash,
        payloadHash,
      )
    }

    return { replayed: false }
  }

  /**
   * Records a successful idempotent execution.
   */
  async record(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
    payload: unknown,
    resultType: string,
    resultId: string,
  ): Promise<void> {
    const payloadHash = hashPayload(payload)
    const record = await this.repository.tryReserve(
      commandType, taskRunId, idempotencyKey, payloadHash, resultType, resultId,
    )
    if (!record) {
      // Already reserved — this shouldn't happen after check()
      throw new Error(`Idempotency key already reserved: ${commandType}:${taskRunId}:${idempotencyKey}`)
    }
  }
}

/** Deterministic hash of the command payload. */
export function hashPayload(payload: unknown): string {
  const canonical = JSON.stringify(payload, Object.keys(payload as object).sort())
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(canonical)
  return hasher.digest("hex")
}
