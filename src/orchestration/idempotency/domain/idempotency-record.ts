/**
 * Idempotency record.
 *
 * Tracks idempotent command execution.
 * Scope: command_type + task_run_id + idempotency_key
 *
 * Payload hash is used to detect mismatched payloads on key reuse.
 */

export interface IdempotencyRecordData {
  readonly id: string
  readonly commandType: string
  readonly taskRunId: string
  readonly idempotencyKey: string
  readonly payloadHash: string
  readonly resultType: string
  readonly resultId: string
  readonly createdAt: Date
}

export class IdempotencyRecord {
  public readonly id: string
  public readonly commandType: string
  public readonly taskRunId: string
  public readonly idempotencyKey: string
  public readonly payloadHash: string
  public readonly resultType: string
  public readonly resultId: string
  public readonly createdAt: Date

  constructor(data: IdempotencyRecordData) {
    this.id = data.id
    this.commandType = data.commandType
    this.taskRunId = data.taskRunId
    this.idempotencyKey = data.idempotencyKey
    this.payloadHash = data.payloadHash
    this.resultType = data.resultType
    this.resultId = data.resultId
    this.createdAt = data.createdAt
  }

  get scopedKey(): string {
    return `${this.commandType}:${this.taskRunId}:${this.idempotencyKey}`
  }
}
