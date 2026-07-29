/**
 * Override request and decision entities.
 * Each override identifies gate, run, SHA, justification, requester, approver.
 */

export type OverrideRequestStatus = "requested" | "approved" | "rejected" | "expired" | "revoked" | "consumed"

export interface OverrideRequestData {
  readonly id: string
  readonly gateId: string
  readonly taskRunId: string
  readonly contractVersionId: string
  readonly contractFamilyId: string
  readonly sha: string
  readonly justification: string
  readonly requester: string
  readonly requesterAuthority: string
  readonly approver?: string
  readonly approverAuthority?: string
  readonly status: OverrideRequestStatus
  readonly failureClass?: string
  readonly createdAt: Date
  readonly decidedAt?: Date
  readonly consumedAt?: Date
  readonly expiresAt?: Date
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
  public readonly requesterAuthority: string
  public readonly approver?: string
  public readonly approverAuthority?: string
  public readonly status: OverrideRequestStatus
  public readonly failureClass?: string
  public readonly createdAt: Date
  public readonly decidedAt?: Date
  public readonly consumedAt?: Date
  public readonly expiresAt?: Date

  constructor(data: OverrideRequestData) {
    this.id = data.id; this.gateId = data.gateId; this.taskRunId = data.taskRunId
    this.contractVersionId = data.contractVersionId; this.contractFamilyId = data.contractFamilyId
    this.sha = data.sha; this.justification = data.justification
    this.requester = data.requester; this.requesterAuthority = data.requesterAuthority
    this.approver = data.approver; this.approverAuthority = data.approverAuthority
    this.status = data.status; this.failureClass = data.failureClass
    this.createdAt = data.createdAt; this.decidedAt = data.decidedAt
    this.consumedAt = data.consumedAt; this.expiresAt = data.expiresAt
  }

  get isActive(): boolean { return this.status === "approved" && !this.isExpired() }

  approve(approver: string, authority: string, now: Date): OverrideRequest {
    return new OverrideRequest({ ...this, status: "approved", approver, approverAuthority: authority, decidedAt: now })
  }
  reject(approver: string, now: Date): OverrideRequest {
    return new OverrideRequest({ ...this, status: "rejected", approver, decidedAt: now })
  }
  revoke(now: Date): OverrideRequest {
    return new OverrideRequest({ ...this, status: "revoked", decidedAt: now })
  }
  expire(now: Date): OverrideRequest {
    return new OverrideRequest({ ...this, status: "expired", decidedAt: now })
  }
  consume(now: Date): OverrideRequest {
    return new OverrideRequest({ ...this, status: "consumed", consumedAt: now })
  }

  belongsToRun(runId: string): boolean { return this.taskRunId === runId }
  matchesSha(sha: string): boolean { return this.sha === sha }
  isExpired(now?: Date): boolean {
    if (this.expiresAt === undefined) return false
    return this.expiresAt <= (now ?? new Date())
  }
}
