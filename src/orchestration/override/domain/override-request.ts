/**
 * OverrideRequest — lifecycle-managed aggregate.
 * Transitions: requested → approved | rejected | expired; approved → revoked | consumed
 */

import { type Instant, type AuthorityLevel, type AggregateVersion, toInstant } from "../../common/types"

export type OverrideRequestStatus = "requested" | "approved" | "rejected" | "expired" | "revoked" | "consumed"

const VALID_TRANSITIONS: Record<OverrideRequestStatus, readonly OverrideRequestStatus[]> = {
  requested: ["approved", "rejected", "expired"],
  approved: ["revoked", "consumed", "expired"],
  rejected: [],
  expired: [],
  revoked: [],
  consumed: [],
}

export class OverrideRequestTransitionError extends Error {
  public readonly code = "OVERRIDE_LIFECYCLE_INVALID"
  public readonly current: OverrideRequestStatus
  public readonly requested: OverrideRequestStatus
  constructor(current: OverrideRequestStatus, requested: OverrideRequestStatus) {
    super(`Cannot transition override from "${current}" to "${requested}"`)
    this.current = current
    this.requested = requested
    this.name = "OverrideRequestTransitionError"
  }
}

export interface OverrideRequestData {
  readonly id: string
  readonly gateId: string
  readonly taskRunId: string
  readonly contractVersionId: string
  readonly contractFamilyId: string
  readonly sha: string
  readonly justification: string
  readonly requester: string
  readonly requesterAuthority: AuthorityLevel
  readonly approver?: string
  readonly approverAuthority?: AuthorityLevel
  readonly status: OverrideRequestStatus
  readonly version: AggregateVersion
  readonly failureClass?: string
  readonly createdAt: Instant
  readonly decidedAt?: Instant
  readonly consumedAt?: Instant
  readonly consumedByDecisionId?: string
  readonly expiresAt?: Instant
}

export class OverrideRequest {
  public readonly id: string
  public readonly gateId: string
  public readonly taskRunId: string
  public readonly contractVersionId: string
  public readonly contractFamilyId: string
  public readonly sha: string
  public readonly justification: string
  public readonly requester: string
  public readonly requesterAuthority: AuthorityLevel
  public readonly approver?: string
  public readonly approverAuthority?: AuthorityLevel
  public readonly status: OverrideRequestStatus
  public readonly version: AggregateVersion
  public readonly failureClass?: string
  public readonly createdAt: Instant
  public readonly decidedAt?: Instant
  public readonly consumedAt?: Instant
  public readonly consumedByDecisionId?: string
  public readonly expiresAt?: Instant

  constructor(data: OverrideRequestData) {
    this.id = data.id; this.gateId = data.gateId; this.taskRunId = data.taskRunId
    this.contractVersionId = data.contractVersionId; this.contractFamilyId = data.contractFamilyId
    this.sha = data.sha; this.justification = data.justification
    this.requester = data.requester; this.requesterAuthority = data.requesterAuthority
    this.approver = data.approver; this.approverAuthority = data.approverAuthority
    this.status = data.status; this.version = data.version; this.failureClass = data.failureClass
    this.createdAt = data.createdAt; this.decidedAt = data.decidedAt
    this.consumedAt = data.consumedAt; this.consumedByDecisionId = data.consumedByDecisionId
    this.expiresAt = data.expiresAt
    Object.freeze(this)
  }

  get isActive(): boolean { return this.status === "approved" && !this.isExpired() }

  private transition(to: OverrideRequestStatus, overrides: Partial<OverrideRequestData>): OverrideRequest {
    const allowed = VALID_TRANSITIONS[this.status]
    if (!allowed.includes(to)) {
      throw new OverrideRequestTransitionError(this.status, to)
    }
    return new OverrideRequest({ ...this, ...overrides, status: to, version: this.version + 1 })
  }

  approve(approver: string, authority: AuthorityLevel, now: Instant): OverrideRequest {
    return this.transition("approved", { approver, approverAuthority: authority, decidedAt: now })
  }
  reject(approver: string, now: Instant): OverrideRequest {
    return this.transition("rejected", { approver, decidedAt: now })
  }
  revoke(now: Instant): OverrideRequest {
    return this.transition("revoked", { decidedAt: now })
  }
  expire(now: Instant): OverrideRequest {
    return this.transition("expired", { decidedAt: now })
  }
  consume(decisionId: string, now: Instant): OverrideRequest {
    return this.transition("consumed", { consumedByDecisionId: decisionId, consumedAt: now })
  }

  belongsToRun(runId: string): boolean { return this.taskRunId === runId }
  matchesSha(sha: string): boolean { return this.sha === sha }
  isExpired(now?: Instant): boolean {
    if (this.expiresAt === undefined) return false
    return this.expiresAt <= (now ?? toInstant(new Date()))
  }
}
