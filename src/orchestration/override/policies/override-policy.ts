/**
 * Override policy — canonical enforcement.
 * Uses the gate policy registry as the single source of truth.
 */

import { OverrideRequest } from "../domain/override-request"
import { hasSufficientAuthority, type Instant } from "../../common/types"
import { getGateDefinition } from "../../completion/domain/gate-policy"
import {
  NonOverridableGateError, OverrideWrongRunError, OverrideWrongShaError,
  OverrideWrongGateError, OverrideExpiredError, OverrideConsumedError,
  InsufficientOverrideAuthorityError,
} from "../domain/errors"

export interface ValidateOverrideInput {
  readonly override: OverrideRequest
  readonly gateId: string
  readonly expectedTaskRunId: string
  readonly expectedSha: string
  readonly expectedContractVersionId: string
  readonly now: Instant
}

export function validateOverrideForCompletion(input: ValidateOverrideInput): void {
  const { override, gateId, expectedTaskRunId, expectedSha, now } = input

  // Gate must match
  if (override.gateId !== gateId) {
    throw new OverrideWrongGateError(gateId)
  }

  // Check overrideability from canonical registry
  const gateDef = getGateDefinition(gateId)
  if (gateDef.overridePolicy.kind === "not_overridable") {
    throw new NonOverridableGateError(gateId)
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
  if (override.isExpired(now)) throw new OverrideExpiredError(override.id)
  if (override.status === "expired") throw new OverrideExpiredError(override.id)
  if (override.status === "consumed") throw new OverrideConsumedError(override.id)
  if (override.status !== "approved") {
    throw new Error(`Override ${override.id} has status "${override.status}", expected "approved"`)
  }

  // Authority check for overridable gates that specify a minimum authority
  if (gateDef.overridePolicy.kind === "overridable") {
    const minAuthority = gateDef.overridePolicy.minimumAuthority
    if (minAuthority && override.approverAuthority) {
      if (!hasSufficientAuthority(override.approverAuthority, minAuthority)) {
        throw new InsufficientOverrideAuthorityError(minAuthority, override.approverAuthority)
      }
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
