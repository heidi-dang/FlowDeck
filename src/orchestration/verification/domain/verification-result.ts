/**
 * VerificationResult entity.
 *
 * A VerificationResult captures the outcome of a single verification rule
 * within a VerificationRun. Results are immutable once completed.
 */

import type { VerificationScope, FailureClass } from "../../contracts/domain/specification"

export type VerificationResultStatus = "pending" | "running" | "passed" | "failed" | "skipped"

export interface VerificationResultData {
  readonly id: string
  readonly runId: string
  readonly ruleId: string
  readonly ruleDescription: string
  readonly scope: VerificationScope
  readonly required: boolean
  readonly failureClass: FailureClass
  readonly status: VerificationResultStatus
  readonly targetSha: string
  readonly evidenceIds: readonly string[]
  readonly message?: string
  readonly createdAt: Date
  readonly completedAt?: Date
}

export class VerificationResult {
  public readonly id: string
  public readonly runId: string
  public readonly ruleId: string
  public readonly ruleDescription: string
  public readonly scope: VerificationScope
  public readonly required: boolean
  public readonly failureClass: FailureClass
  public readonly status: VerificationResultStatus
  public readonly targetSha: string
  public readonly evidenceIds: readonly string[]
  public readonly message?: string
  public readonly createdAt: Date
  public readonly completedAt?: Date

  constructor(data: VerificationResultData) {
    this.id = data.id
    this.runId = data.runId
    this.ruleId = data.ruleId
    this.ruleDescription = data.ruleDescription
    this.scope = data.scope
    this.required = data.required
    this.failureClass = data.failureClass
    this.status = data.status
    this.targetSha = data.targetSha
    this.evidenceIds = Object.freeze([...data.evidenceIds])
    this.message = data.message
    this.createdAt = data.createdAt
    this.completedAt = data.completedAt
  }

  get isTerminal(): boolean {
    return this.status === "passed" || this.status === "failed" || this.status === "skipped"
  }

  get isPassing(): boolean {
    return this.status === "passed"
  }

  /** Failure class is immutable after creation. */
  withStatus(status: VerificationResultStatus, now?: Date): VerificationResult {
    return new VerificationResult({
      ...this,
      status,
      completedAt: status === "passed" || status === "failed" || status === "skipped" ? (now ?? new Date()) : undefined,
    })
  }
}
