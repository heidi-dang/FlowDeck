/**
 * Approval policy.
 * Enforces run/SHA/contract binding, authority, expiry, and self-approval rules.
 */

import { ApprovalRequest } from "../domain/approval-request"
import { ApprovalDecision } from "../domain/approval-decision"
import { hasSufficientAuthority, getRequiredAuthorityForGate, type AuthorityLevel } from "../domain/authority"
import {
  InsufficientAuthorityError, ApprovalWrongRunError, ApprovalWrongShaError,
  ApprovalWrongContractError, ApprovalExpiredError, ApprovalRejectedError, ApprovalRevokedError,
} from "../domain/errors"

export interface ValidateApprovalInput {
  readonly request: ApprovalRequest
  readonly decision: ApprovalDecision
  readonly expectedTaskRunId: string
  readonly expectedSha: string
  readonly expectedContractVersionId: string
  readonly now: Date
  readonly allowSelfApproval: boolean
}

export interface ApprovalGateCheck {
  readonly request: ApprovalRequest | undefined
  readonly decision: ApprovalDecision | undefined
  readonly expectedTaskRunId: string
  readonly expectedSha: string
  readonly expectedContractVersionId: string
  readonly now: Date
  readonly allowSelfApproval: boolean
}

export type ApprovalGateStatus = "satisfied" | "pending" | "failed"

export function checkApprovalGate(input: ApprovalGateCheck): { status: ApprovalGateStatus; reasons: string[] } {
  const reasons: string[] = []

  if (!input.request) {
    reasons.push("No approval request exists for this gate")
    return { status: "failed", reasons }
  }

  if (input.request.status === "pending") {
    reasons.push("Approval request is still pending")
    return { status: "pending", reasons }
  }

  if (!input.request.belongsToRun(input.expectedTaskRunId)) {
    reasons.push(`Approval belongs to run ${input.request.taskRunId}, expected ${input.expectedTaskRunId}`)
    return { status: "failed", reasons }
  }

  if (input.request.isExpired(input.now)) {
    reasons.push("Approval has expired")
    return { status: "failed", reasons }
  }

  if (input.request.status === "expired") {
    reasons.push("Approval is expired")
    return { status: "failed", reasons }
  }

  if (input.request.status === "revoked") {
    reasons.push("Approval has been revoked")
    return { status: "failed", reasons }
  }

  if (input.request.status === "rejected") {
    reasons.push("Approval was rejected")
    return { status: "failed", reasons }
  }

  if (!input.decision) {
    if (input.request.status === "approved") {
      // If the request says approved but there's no decision record, treat as pending
      reasons.push("Approval decision record is missing")
      return { status: "pending", reasons }
    }
    reasons.push("No approval decision has been recorded")
    return { status: "failed", reasons }
  }

  if (input.decision.outcome === "rejected") {
    reasons.push("Approval was rejected")
    return { status: "failed", reasons }
  }

  if (!input.decision.approver || input.decision.approver.length === 0) {
    reasons.push("Approval has no approver identity")
    return { status: "failed", reasons }
  }

  return { status: "satisfied", reasons: [] }
}

export function validateApprovalDecision(input: ValidateApprovalInput): void {
  const { request, decision, expectedTaskRunId, expectedSha, expectedContractVersionId, now, allowSelfApproval } = input

  if (decision.outcome === "rejected") {
    if (!allowSelfApproval && decision.approver === request.requester) {
      throw new InsufficientAuthorityError("requires_different_approver", decision.approver)
    }
    return // rejection is always valid as long as not self-approved if prohibited
  }

  if (!request.belongsToRun(expectedTaskRunId)) {
    throw new ApprovalWrongRunError(expectedTaskRunId, request.taskRunId)
  }
  if (!request.matchesSha(expectedSha)) {
    throw new ApprovalWrongShaError(expectedSha, request.sha)
  }
  if (!request.matchesContract(expectedContractVersionId)) {
    throw new ApprovalWrongContractError(expectedContractVersionId, request.contractVersionId)
  }
  if (request.isExpired(now)) {
    throw new ApprovalExpiredError(request.id)
  }
  if (request.status === "revoked") {
    throw new ApprovalRevokedError(request.id)
  }
  if (request.status === "rejected") {
    throw new ApprovalRejectedError(request.id)
  }

  const requiredLevel: AuthorityLevel = getRequiredAuthorityForGate(request.gateId)
  const allowedLevel: AuthorityLevel = decision.approverAuthority as AuthorityLevel
  if (!hasSufficientAuthority(allowedLevel, requiredLevel)) {
    throw new InsufficientAuthorityError(requiredLevel, allowedLevel)
  }

  if (!allowSelfApproval && decision.approver === request.requester) {
    throw new InsufficientAuthorityError("requires_different_approver", decision.approver)
  }
}
