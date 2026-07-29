/**
 * Activation service.
 *
 * Orchestrates the contract activation workflow:
 * 1. Validates the draft is complete and activation is allowed
 * 2. Recomputes the specification hash (purity check)
 * 3. Transitions the version to "activated" status
 * 4. Records the activation timestamp
 */

import { ContractFamily, ContractVersion } from "../domain/contract"
import { validateActivation } from "../policies/activation-policy"
import { validateStatusTransition } from "../policies/version-policy"
import { type Clock } from "../../common/ports/clock"

export interface ActivateVersionInput {
  readonly family: ContractFamily
  readonly versionId: string
  readonly clock: Clock
}

export interface ActivationResult {
  readonly family: ContractFamily
  readonly version: ContractVersion
}

/**
 * Activates a contract version after validating all policies.
 *
 * Returns the updated family and version. Does not persist — the caller
 * is responsible for storing via a repository.
 */
export function activateVersion(input: ActivateVersionInput): ActivationResult {
  const { family, versionId, clock } = input

  const version = family.versions.find((v) => v.id === versionId)
  if (!version) {
    throw new Error(`Version ${versionId} not found in family ${family.id}`)
  }

  // Validate activation policy
  validateActivation({
    family,
    versionId,
    specification: {
      requirements: version.specification.requirements,
      acceptanceCriteria: version.specification.acceptanceCriteria,
      verificationRules: version.specification.verificationRules,
    },
  })

  // Validate status transition is allowed
  validateStatusTransition(version, "activated")

  // Create activated version
  const activatedVersion = new ContractVersion({
    ...version,
    status: "activated",
    activatedAt: clock.now(),
  })

  // Return updated family with the activated version
  const updatedFamily = family.withReplacedVersion(activatedVersion)

  return { family: updatedFamily, version: activatedVersion }
}
