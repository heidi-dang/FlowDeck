import type { IdempotencyRecord } from "../domain/idempotency-record"
import type { Instant } from "../../common/types"

export type ReservationResult =
  | { status: "acquired"; record: IdempotencyRecord }
  | { status: "completed"; record: IdempotencyRecord }
  | { status: "in_progress"; record: IdempotencyRecord }
  | { status: "conflict"; record: IdempotencyRecord; expectedPayloadHash: string; actualPayloadHash: string }

export interface IdempotencyRepository {
  /** Atomically reserve or return the existing record status. */
  tryReserve(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
    payloadHash: string,
    createdAt: Instant,
  ): Promise<ReservationResult>

  /** Transition from reserved → completed with result linkage. */
  completeReservation(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
    resultType: string,
    resultId: string,
    completedAt: Instant,
  ): Promise<void>

  /** Transition from reserved → released (rollback). */
  releaseReservation(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
  ): Promise<void>

  /** Lookup by scoped key. */
  getByScopedKey(commandType: string, taskRunId: string, idempotencyKey: string): Promise<IdempotencyRecord | undefined>
}
