/**
 * Approval policy enforcement.
 * Uses canonical gate policy registry, typed authority, and versioned approval policy.
 */

import { ApprovalRequest } from "../domain/approval-request"
import { ApprovalDecision } from "../domain/approval-decision"
import { type ApprovalPolicy, getMinimumAuthorityForGate } from "../domain/approval-policy"
import { hasSufficientAuthority, type Instant } from "../../common/types"
import { getGateDefinition } from "../../completion/domain/gate-policy"
import {
  InsufficientAuthorityError, ApprovalWrongRunError, ApprovalWrongShaError,
  ApprovalWrongContractError, ApprovalExpiredError, ApprovalRejectedError, ApprovalRevokedError,
} from "../domain/errors"

export interface ApprovalGateCheckResult {
  readonly satisfied: boolean
  readonly reasons: readonly string[]
}

/**
 * Checks whether an approval gate is satisfied.
 * Uses exact binding fields — no ambiguous matching.
 */
export function checkApprovalGate(
  request: ApprovalRequest,
  decision: ApprovalDecision | undefined,
  expectedTaskRunId: string,
  expectedSha: string,
  expectedContractVersionId: string,
  now: Instant,
  _policy: ApprovalPolicy,
): ApprovalGateCheckResult {
  const reasons: string[] = []

  if (!request) {
    return { satisfied: false, reasons: Object.freeze(["No approval request exists"]) }
  }

  if (request.status === "pending") {
    return { satisfied: false, reasons: Object.freeze(["Approval request is still pending"]) }
  }

  // Exact binding checks
  if (!request.belongsToRun(expectedTaskRunId)) {
    return { satisfied: false, reasons: Object.freeze([`Approval belongs to run ${request.taskRunId}, expected ${expectedTaskRunId}`]) }
  }
  if (!request.matchesSha(expectedSha)) {
    return { satisfied: false, reasons: Object.freeze([`Approval targets SHA ${request.sha}, expected ${expectedSha}`]) }
  }
  if (!request.matchesContract(expectedContractVersionId)) {
    return { satisfied: false, reasons: Object.freeze([`Approval targets contract ${request.contractVersionId}, expected ${expectedContractVersionId}`]) }
  }
  if (request.isExpired(now)) {
    return { satisfied: false, reasons: Object.freeze(["Approval has expired"]) }
  }

  if (request.status === "expired") reasons.push("Approval is expired")
  else if (request.status === "revoked") reasons.push("Approval has been revoked")
  else if (request.status === "rejected") reasons.push("Approval was rejected")

  if (reasons.length > 0) {
    return { satisfied: false, reasons: Object.freeze(reasons) }
  }

  // Must have a decision record
  if (!decision) {
    return { satisfied: false, reasons: Object.freeze(["No approval decision record exists"]) }
  }

  if (decision.outcome === "rejected") {
    return { satisfied: false, reasons: Object.freeze(["Approval was rejected"]) }
  }

  if (!decision.approver || decision.approver.length === 0) {
    return { satisfied: false, reasons: Object.freeze(["Approval has no approver identity"]) }
  }

  return { satisfied: true, reasons: Object.freeze([]) }
}

export function validateApprovalBinding(
  request: ApprovalRequest,
  decision: ApprovalDecision,
  expectedTaskRunId: string,
  expectedSha: string,
  expectedContractVersionId: string,
  now: Instant,
  policy: ApprovalPolicy,
): void {
  // Binding checks
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
  if (request.status === "revoked") throw new ApprovalRevokedError(request.id)
  if (request.status === "rejected") throw new ApprovalRejectedError(request.id)

  // Authority check (only for approvals, not rejections)
  if (decision.outcome === "approved") {
    const gateDef = getGateDefinition(request.gateId)
    if (gateDef.overridePolicy.kind !== "not_overridable") {
      const requiredLevel = getMinimumAuthorityForGate(request.gateId as any)
      if (!hasSufficientAuthority(decision.approverAuthority, requiredLevel)) {
        throw new InsufficientAuthorityError(requiredLevel, decision.approverAuthority)
      }
    }

    // Self-approval check
    if (!policy.allowSelfApproval && decision.approver === request.requester) {
      throw new InsufficientAuthorityError("requires_different_approver(denied_by_policy)", decision.approver)
    }
  }
}
