/**
 * Centralized override policy.
 *
 * Determines:
 * - Which gates are overridable (and at what authority level)
 * - Whether an override request can satisfy a failing gate
 * - Whether an override has the right run, SHA, and gate binding
 */

import { OverrideRequest } from "../domain/override-request"
import { type AuthorityLevel, hasSufficientAuthority, getRequiredAuthorityForGate } from "../../approval/domain/authority"
import {
  NonOverridableGateError, OverrideWrongRunError, OverrideWrongShaError,
  OverrideWrongGateError, OverrideExpiredError, OverrideConsumedError,
  InsufficientOverrideAuthorityError,
} from "../domain/errors"

export type OverrideResult = "overridable" | "not_overridable" | "requires_escalated_authority"

/**
 * Determines whether a gate can be overridden.
 */
export function getGateOverrideability(gateId: string): OverrideResult {
  // Non-overridable gates — integrity, identity, consistency
  const nonOverridable: readonly string[] = [
    "current-sha-matches-verification",  // SHA consistency is foundational
    "required-assignments-complete",      // Run identity consistency
  ]
  // Gates requiring escalated authority
  const escalated: readonly string[] = [
    "critical-acceptance-criteria-passed",
    "critical-requirements-verified",
  ]

  if (nonOverridable.includes(gateId)) return "not_overridable"
  if (escalated.includes(gateId)) return "requires_escalated_authority"
  return "overridable" // verification-policy-satisfied, mandatory-evidence-current
}

export interface ValidateOverrideInput {
  readonly override: OverrideRequest
  readonly gateId: string
  readonly expectedTaskRunId: string
  readonly expectedSha: string
  readonly now: Date
  readonly _expectedContractVersionId?: string
}

/**
 * Validates an override for use in completion.
 * Throws on validation failure.
 * Returns the matching override on success.
 */
export function validateOverrideForCompletion(input: ValidateOverrideInput): void {
  const { override, gateId, expectedTaskRunId, expectedSha, now } = input

  // Check gate overrideability
  const overridability = getGateOverrideability(gateId)
  if (overridability === "not_overridable") {
    throw new NonOverridableGateError(gateId)
  }

  // Gate ID must match
  if (override.gateId !== gateId) {
    throw new OverrideWrongGateError(gateId)
  }

  // Run ownership
  if (!override.belongsToRun(expectedTaskRunId)) {
    throw new OverrideWrongRunError(expectedTaskRunId, override.taskRunId)
  }

  // SHA binding
  if (!override.matchesSha(expectedSha)) {
    throw new OverrideWrongShaError(expectedSha, override.sha)
  }

  // Status checks
  if (override.isExpired(now)) {
    throw new OverrideExpiredError(override.id)
  }
  if (override.status === "expired") {
    throw new OverrideExpiredError(override.id)
  }
  if (override.status === "consumed") {
    throw new OverrideConsumedError(override.id)
  }
  if (override.status !== "approved") {
    throw new Error(`Override ${override.id} has status "${override.status}", expected "approved"`)
  }

  // Authority check for escalated gates
  if (overridability === "requires_escalated_authority") {
    const requiredLevel: AuthorityLevel = getRequiredAuthorityForGate(gateId)
    const actualLevel = override.approverAuthority as AuthorityLevel
    if (!hasSufficientAuthority(actualLevel, requiredLevel)) {
      throw new InsufficientOverrideAuthorityError(requiredLevel, actualLevel)
    }
  }
}

export function checkDuplicateActiveOverride(
  overrides: OverrideRequest[],
  gateId: string,
  taskRunId: string,
): boolean {
  return overrides.some(
    (o) => o.gateId === gateId && o.taskRunId === taskRunId && o.isActive
  )
}
