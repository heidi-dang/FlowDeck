import { type Instant } from "../../common/types"

export type IdempotencyStatus = "reserved" | "completed" | "released"

export interface IdempotencyRecordData {
  readonly id: string
  readonly commandType: string
  readonly taskRunId: string
  readonly idempotencyKey: string
  readonly payloadHash: string
  readonly status: IdempotencyStatus
  readonly resultType?: string
  readonly resultId?: string
  readonly completedAt?: Instant
  readonly createdAt: Instant
}

export class IdempotencyRecord {
  public readonly id: string
  public readonly commandType: string
  public readonly taskRunId: string
  public readonly idempotencyKey: string
  public readonly payloadHash: string
  public readonly status: IdempotencyStatus
  public readonly resultType?: string
  public readonly resultId?: string
  public readonly completedAt?: Instant
  public readonly createdAt: Instant

  constructor(data: IdempotencyRecordData) {
    this.id = data.id; this.commandType = data.commandType; this.taskRunId = data.taskRunId
    this.idempotencyKey = data.idempotencyKey; this.payloadHash = data.payloadHash
    this.status = data.status; this.resultType = data.resultType; this.resultId = data.resultId
    this.completedAt = data.completedAt; this.createdAt = data.createdAt
    Object.freeze(this)
  }

  get scopedKey(): string { return `${this.commandType}:${this.taskRunId}:${this.idempotencyKey}` }

  complete(resultType: string, resultId: string, now: Instant): IdempotencyRecord {
    return new IdempotencyRecord({ ...this, status: "completed", resultType, resultId, completedAt: now })
  }

  release(): IdempotencyRecord {
    return new IdempotencyRecord({ ...this, status: "released" })
  }
}
