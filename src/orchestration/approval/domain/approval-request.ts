/**
 * ApprovalRequest — lifecycle-managed aggregate.
 * Transitions: pending → approved | rejected | expired; approved → revoked
 */

import { type Instant, type AuthorityLevel, type AggregateVersion } from "../../common/types"

export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "expired" | "revoked"

const VALID_TRANSITIONS: Record<ApprovalRequestStatus, readonly ApprovalRequestStatus[]> = {
  pending: ["approved", "rejected", "expired"],
  approved: ["revoked", "expired"],
  rejected: [],
  expired: [],
  revoked: [],
}

export class ApprovalRequestTransitionError extends Error {
  public readonly code = "APPROVAL_LIFECYCLE_INVALID"
  public readonly current: ApprovalRequestStatus
  public readonly requested: ApprovalRequestStatus
  constructor(current: ApprovalRequestStatus, requested: ApprovalRequestStatus) {
    super(`Cannot transition approval from "${current}" to "${requested}"`)
    this.current = current
    this.requested = requested
    this.name = "ApprovalRequestTransitionError"
  }
}

export interface ApprovalRequestData {
  readonly id: string
  readonly taskRunId: string
  readonly contractVersionId: string
  readonly contractFamilyId: string
  readonly gateId: string
  readonly sha: string
  readonly requester: string
  readonly requesterAuthority: AuthorityLevel
  readonly reason: string
  readonly status: ApprovalRequestStatus
  readonly version: AggregateVersion
  readonly createdAt: Instant
  readonly expiresAt?: Instant
  readonly decidedAt?: Instant
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
  public readonly requesterAuthority: AuthorityLevel
  public readonly reason: string
  public readonly status: ApprovalRequestStatus
  public readonly version: AggregateVersion
  public readonly createdAt: Instant
  public readonly expiresAt?: Instant
  public readonly decidedAt?: Instant
  public readonly decidedBy?: string
  public readonly decisionReason?: string

  constructor(data: ApprovalRequestData) {
    this.id = data.id; this.taskRunId = data.taskRunId
    this.contractVersionId = data.contractVersionId; this.contractFamilyId = data.contractFamilyId
    this.gateId = data.gateId; this.sha = data.sha
    this.requester = data.requester; this.requesterAuthority = data.requesterAuthority
    this.reason = data.reason; this.status = data.status; this.version = data.version
    this.createdAt = data.createdAt; this.expiresAt = data.expiresAt
    this.decidedAt = data.decidedAt; this.decidedBy = data.decidedBy
    this.decisionReason = data.decisionReason
    Object.freeze(this)
  }

  get isActive(): boolean {
    return this.status === "pending" || this.status === "approved"
  }

  private transition(to: ApprovalRequestStatus, overrides: Partial<ApprovalRequestData>): ApprovalRequest {
    const allowed = VALID_TRANSITIONS[this.status]
    if (!allowed.includes(to)) {
      throw new ApprovalRequestTransitionError(this.status, to)
    }
    return new ApprovalRequest({ ...this, ...overrides, status: to, version: this.version + 1 })
  }

  approve(decidedBy: string, now: Instant): ApprovalRequest {
    return this.transition("approved", { decidedBy, decidedAt: now })
  }

  reject(decidedBy: string, reason: string, now: Instant): ApprovalRequest {
    return this.transition("rejected", { decidedBy, decisionReason: reason, decidedAt: now })
  }

  revoke(now: Instant): ApprovalRequest {
    return this.transition("revoked", { decidedAt: now })
  }

  expire(now: Instant): ApprovalRequest {
    return this.transition("expired", { decidedAt: now })
  }

  belongsToRun(runId: string): boolean { return this.taskRunId === runId }
  matchesSha(sha: string): boolean { return this.sha === sha }
  matchesContract(versionId: string): boolean { return this.contractVersionId === versionId }
  isExpired(now: Instant): boolean { return this.expiresAt !== undefined && this.expiresAt <= now }
}
