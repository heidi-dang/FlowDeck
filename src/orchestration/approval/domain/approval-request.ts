/**
 * ApprovalRequest entity.
 * A request for approval on a completion gate override.
 */

export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "expired" | "revoked"

export interface ApprovalRequestData {
  readonly id: string
  readonly taskRunId: string
  readonly contractVersionId: string
  readonly contractFamilyId: string
  readonly gateId: string
  readonly sha: string
  readonly requester: string
  readonly requesterAuthority: string
  readonly reason: string
  readonly status: ApprovalRequestStatus
  readonly createdAt: Date
  readonly expiresAt?: Date
  readonly decidedAt?: Date
  readonly decidedBy?: string
  readonly decisionReason?: string
}

export class ApprovalRequest {
  public readonly id: string
  public readonly taskRunId: string
  public readonly contractVersionId: string
  public readonly contractFamilyId: string
  public readonly gateId: string
  public readonly sha: string
  public readonly requester: string
  public readonly requesterAuthority: string
  public readonly reason: string
  public readonly status: ApprovalRequestStatus
  public readonly createdAt: Date
  public readonly expiresAt?: Date
  public readonly decidedAt?: Date
  public readonly decidedBy?: string
  public readonly decisionReason?: string

  constructor(data: ApprovalRequestData) {
    this.id = data.id
    this.taskRunId = data.taskRunId
    this.contractVersionId = data.contractVersionId
    this.contractFamilyId = data.contractFamilyId
    this.gateId = data.gateId
    this.sha = data.sha
    this.requester = data.requester
    this.requesterAuthority = data.requesterAuthority
    this.reason = data.reason
    this.status = data.status
    this.createdAt = data.createdAt
    this.expiresAt = data.expiresAt
    this.decidedAt = data.decidedAt
    this.decidedBy = data.decidedBy
    this.decisionReason = data.decisionReason
  }

  get isActive(): boolean {
    return this.status === "pending" || this.status === "approved"
  }

  approve(decidedBy: string, reason: string, now: Date): ApprovalRequest {
    return new ApprovalRequest({ ...this, status: "approved", decidedBy, decisionReason: reason, decidedAt: now })
  }

  reject(decidedBy: string, reason: string, now: Date): ApprovalRequest {
    return new ApprovalRequest({ ...this, status: "rejected", decidedBy, decisionReason: reason, decidedAt: now })
  }

  revoke(now: Date): ApprovalRequest {
    return new ApprovalRequest({ ...this, status: "revoked", decidedAt: now })
  }

  expire(now: Date): ApprovalRequest {
    return new ApprovalRequest({ ...this, status: "expired", decidedAt: now })
  }

  belongsToRun(runId: string): boolean { return this.taskRunId === runId }
  matchesSha(sha: string): boolean { return this.sha === sha }
  matchesContract(versionId: string): boolean { return this.contractVersionId === versionId }
  isExpired(now: Date): boolean { return this.expiresAt !== undefined && this.expiresAt <= now }
}
