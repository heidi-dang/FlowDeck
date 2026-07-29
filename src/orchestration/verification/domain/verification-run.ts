/**
 * VerificationRun entity.
 *
 * A VerificationRun represents a single execution of a contract's verification
 * suite against a specific target SHA. It groups multiple VerificationResults.
 */

export type VerificationRunStatus = "pending" | "running" | "completed" | "failed"

export interface VerificationRunData {
  readonly id: string
  readonly contractVersionId: string
  readonly targetSha: string
  readonly status: VerificationRunStatus
  readonly createdAt: Date
  readonly completedAt?: Date
}

export class VerificationRun {
  public readonly id: string
  public readonly contractVersionId: string
  public readonly targetSha: string
  public readonly status: VerificationRunStatus
  public readonly createdAt: Date
  public readonly completedAt?: Date

  constructor(data: VerificationRunData) {
    this.id = data.id
    this.contractVersionId = data.contractVersionId
    this.targetSha = data.targetSha
    this.status = data.status
    this.createdAt = data.createdAt
    this.completedAt = data.completedAt
  }

  get isComplete(): boolean {
    return this.status === "completed" || this.status === "failed"
  }

  withStatus(status: VerificationRunStatus, now?: Date): VerificationRun {
    return new VerificationRun({
      ...this,
      status,
      completedAt: status === "completed" || status === "failed" ? (now ?? new Date()) : undefined,
    })
  }
}
