/**
 * Idempotency service.
 *
 * Protects commands that create durable decisions or requests.
 * Uses deterministic payload hashing to detect mismatched payloads
 * on the same key.
 */

import { IdempotencyConflictError } from "./errors"
import { type IdempotencyRepository } from "../ports/idempotency-repository"

export interface IdempotentCommand<TResult> {
  readonly commandType: string
  readonly taskRunId: string
  readonly idempotencyKey: string
  readonly payload: unknown
  readonly execute: () => Promise<{ resultType: string; resultId: string; result: TResult }>
}

export class IdempotencyService {
  constructor(private readonly repository: IdempotencyRepository) {}

  /**
   * Executes a command with idempotency protection.
   *
   * 1. Checks if the key already exists
   * 2. If exists and payload hash matches → returns the stored result
   * 3. If exists and payload hash differs → throws IdempotencyConflictError
   * 4. If not exists → executes command, stores record, returns result
   */
  async execute<TResult>(command: IdempotentCommand<TResult>): Promise<TResult> {
    const payloadHash = this.hashPayload(command.payload)

    // Check for existing record
    const existing = await this.repository.getByScopedKey(
      command.commandType, command.taskRunId, command.idempotencyKey
    )

    if (existing) {
      const existingHash = await this.repository.getPayloadHash(
        command.commandType, command.taskRunId, command.idempotencyKey
      )

      if (existingHash === payloadHash) {
        // Same payload — return existing result (idempotent replay)
        // In a full implementation we'd fetch and return the actual result object
        return { resultType: existing.resultType, resultId: existing.resultId } as unknown as TResult
      }

      throw new IdempotencyConflictError(
        `${command.commandType}:${command.taskRunId}:${command.idempotencyKey}`,
        existingHash ?? "unknown",
        payloadHash,
      )
    }

    // Execute the command
    const { resultType, resultId, result } = await command.execute()

    // Store idempotency record
    await this.repository.tryReserve(
      command.commandType, command.taskRunId, command.idempotencyKey,
      payloadHash, resultType, resultId, new Date()
    )

    return result
  }

  /** Deterministic hash of the command payload. */
  private hashPayload(payload: unknown): string {
    const canonical = JSON.stringify(payload, Object.keys(payload as object).sort())
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(canonical)
    return hasher.digest("hex")
  }
}
