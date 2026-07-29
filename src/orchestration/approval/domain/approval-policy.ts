/**
 * Versioned approval policy.
 * Canonical source for self-approval and authority rules.
 */

import { type PolicyVersion, type AuthorityLevel, type GateId, CURRENT_POLICY_VERSION } from "../../common/types"
import { getGateDefinition } from "../../completion/domain/gate-policy"

export interface ApprovalPolicy {
  readonly version: PolicyVersion
  readonly allowSelfApproval: boolean
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  version: CURRENT_POLICY_VERSION,
  allowSelfApproval: false, // Default is deny
}

export function getMinimumAuthorityForGate(gateId: GateId): AuthorityLevel {
  const def = getGateDefinition(gateId)
  if (def.overridePolicy.kind === "not_overridable") {
    throw new Error(`Gate "${gateId}" is not overridable - no authority applies`)
  }
  return def.overridePolicy.minimumAuthority ?? "reviewer"
}

export function isApprovalRequiredForOverride(gateId: string): boolean {
  const def = getGateDefinition(gateId)
  if (def.overridePolicy.kind === "not_overridable") return false
  return def.overridePolicy.approvalRequired
}
