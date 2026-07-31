/**
 * Activation policy.
 *
 * Governs when a contract version may be activated and enforces the
 * one-active-version invariant per contract family.
 */

import type { ContractFamily } from "../domain/contract"
import { ActivationError, IncompleteDraftError } from "../domain/errors"

export interface ActivationValidationInput {
  readonly family: ContractFamily
  readonly versionId: string
  readonly specification: { readonly requirements: readonly unknown[]; readonly acceptanceCriteria: readonly unknown[]; readonly verificationRules: readonly unknown[] }
}

/**
 * Validates that a contract version can be activated.
 *
 * Rules:
 * 1. The specification must not be empty (at least one requirement, criterion, or rule).
 * 2. The specification must have at least one critical requirement or acceptance criterion.
 * 3. No other version in the family is already activated (one-active-version policy).
 */
export function validateActivation(input: ActivationValidationInput): void {
  const { family, versionId, specification } = input

  // Find the version
  const version = family.versions.find((v) => v.id === versionId)
  if (!version) {
    throw new ActivationError(`Version ${versionId} not found in family ${family.id}`)
  }

  // Rule 1: Specification must not be empty
  if (
    specification.requirements.length === 0 &&
    specification.acceptanceCriteria.length === 0 &&
    specification.verificationRules.length === 0
  ) {
    throw new IncompleteDraftError(
      "Specification must have at least one requirement, acceptance criterion, or verification rule"
    )
  }

  // Rule 2: Must have at least one critical item
  const hasCriticalRequirement = specification.requirements.some(
    (r) => (r as { priority: string }).priority === "critical"
  )
  const hasCriticalCriterion = specification.acceptanceCriteria.some(
    (a) => (a as { priority: string }).priority === "critical"
  )
  if (!hasCriticalRequirement && !hasCriticalCriterion) {
    throw new IncompleteDraftError(
      "Specification must include at least one critical requirement or acceptance criterion"
    )
  }

  // Rule 3: One-active-version policy
  const activeVersion = family.activeVersion
  if (activeVersion && activeVersion.id !== versionId) {
    throw new ActivationError(
      `Family ${family.id} already has an active version (${activeVersion.version}). ` +
        "Deprecate the active version first before activating a new one."
    )
  }

  // Must be in draft status to activate
  if (version.status !== "draft") {
    throw new ActivationError(
      `Version ${versionId} has status "${version.status}"; only draft versions may be activated`
    )
  }
}
