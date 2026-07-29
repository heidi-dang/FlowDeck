/**
 * ApprovalDecision — immutable record.
 * Once created, absolutely no mutation possible (deep frozen).
 */

import { type Instant, type PolicyVersion, type AuthorityLevel } from "../../common/types"

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
  readonly approverAuthority: AuthorityLevel
  readonly reason: string
  readonly createdAt: Instant
  readonly policyVersion: PolicyVersion
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
  public readonly approverAuthority: AuthorityLevel
  public readonly reason: string
  public readonly createdAt: Instant
  public readonly policyVersion: PolicyVersion

  constructor(data: ApprovalDecisionData) {
    this.id = data.id; this.requestId = data.requestId; this.taskRunId = data.taskRunId
    this.contractFamilyId = data.contractFamilyId; this.contractVersionId = data.contractVersionId
    this.gateId = data.gateId; this.sha = data.sha; this.outcome = data.outcome
    this.approver = data.approver; this.approverAuthority = data.approverAuthority
    this.reason = data.reason; this.createdAt = data.createdAt; this.policyVersion = data.policyVersion
    Object.freeze(this)
  }
}
