/**
 * ApprovalDecision — immutable record of an approval outcome.
 * Once created, an ApprovalDecision is never mutated.
 * A later revocation creates a new audit record.
 */

export type ApprovalOutcome = "approved" | "rejected"

export interface ApprovalDecisionData {
  readonly id: string
  readonly requestId: string
  readonly taskRunId: string
  readonly contractFamilyId: string
  readonly contractVersionId: string
  readonly gateId: string
  readonly sha: string
  readonly outcome: ApprovalOutcome
  readonly approver: string
  readonly approverAuthority: string
  readonly reason: string
  readonly createdAt: Date
  readonly policyVersion: string
}

export class ApprovalDecision {
  public readonly id: string
  public readonly requestId: string
  public readonly taskRunId: string
  public readonly contractFamilyId: string
  public readonly contractVersionId: string
  public readonly gateId: string
  public readonly sha: string
  public readonly outcome: ApprovalOutcome
  public readonly approver: string
  public readonly approverAuthority: string
  public readonly reason: string
  public readonly createdAt: Date
  public readonly policyVersion: string

  constructor(data: ApprovalDecisionData) {
    this.id = data.id
    this.requestId = data.requestId
    this.taskRunId = data.taskRunId
    this.contractFamilyId = data.contractFamilyId
    this.contractVersionId = data.contractVersionId
    this.gateId = data.gateId
    this.sha = data.sha
    this.outcome = data.outcome
    this.approver = data.approver
    this.approverAuthority = data.approverAuthority
    this.reason = data.reason
    this.createdAt = data.createdAt
    this.policyVersion = data.policyVersion
    Object.freeze(this)
  }
}
