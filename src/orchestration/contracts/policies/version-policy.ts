/**
 * Version lifecycle policy.
 *
 * Governs state transitions for contract versions:
 *   draft → activated → deprecated
 *   draft → activated → superseded
 *   draft → (deleted, if never activated)
 *
 * Activated versions are immutable: their specification and hash may not change.
 */

import { ContractVersion, type ContractVersionStatus } from "../domain/contract"
import { ActivationError, ImmutableContractError } from "../domain/errors"

/**
 * Allowed status transitions.
 */
const ALLOWED_TRANSITIONS: Record<ContractVersionStatus, readonly ContractVersionStatus[]> = {
  draft: ["activated", "deprecated"],
  activated: ["deprecated", "superseded"],
  deprecated: [],
  superseded: [],
}

/**
 * Returns true if the status transition is valid.
 */
export function isValidTransition(from: ContractVersionStatus, to: ContractVersionStatus): boolean {
  const allowed = ALLOWED_TRANSITIONS[from]
  return allowed.includes(to)
}

/**
 * Validates that a version can transition to a new status.
 *
 * Specifically enforces:
 * - Only valid state transitions are allowed
 * - Activated versions cannot have their specification mutated
 */
export function validateStatusTransition(version: ContractVersion, newStatus: ContractVersionStatus): void {
  if (!isValidTransition(version.status, newStatus)) {
    throw new ActivationError(
      `Cannot transition from "${version.status}" to "${newStatus}"`
    )
  }
}

/**
 * Validates that an activated version's specification is not being modified.
 */
export function validateImmutability(version: ContractVersion): void {
  if (version.isActivated) {
    throw new ImmutableContractError(
      "Cannot modify an activated contract version. Create a new draft version instead."
    )
  }
}
