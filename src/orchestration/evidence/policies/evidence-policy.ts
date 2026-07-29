/**
 * Evidence policy.
 *
 * Governs evidence lifecycle, validity, and enforcement rules.
 */

import type { Evidence } from "../domain/evidence"
import { EvidenceShaMismatchError, EvidenceCrossRunError } from "../domain/errors"

export interface EvidenceValidationInput {
  readonly evidence: Evidence
  readonly expectedSha: string
  readonly expectedRunId: string
}

/**
 * Validates evidence against SHA binding and run ownership requirements.
 * Throws domain errors on violation.
 */
export function validateEvidenceBinding(input: EvidenceValidationInput): void {
  if (input.evidence.sha !== input.expectedSha) {
    throw new EvidenceShaMismatchError(input.expectedSha, input.evidence.sha)
  }

  if (input.evidence.runId !== input.expectedRunId) {
    throw new EvidenceCrossRunError(
      `Evidence belongs to run ${input.evidence.runId}, expected ${input.expectedRunId}`
    )
  }
}

/**
 * Returns true if evidence is current and valid for the given SHA and run.
 */
export function isEvidenceCurrent(input: EvidenceValidationInput): boolean {
  return (
    !input.evidence.isArchived &&
    input.evidence.matchesSha(input.expectedSha) &&
    input.evidence.belongsToRun(input.expectedRunId)
  )
}

/**
 * Returns true if evidence satisfies the evidence requirement for a criterion.
 * Archived evidence is still available for historical traceability but is
 * not considered current.
 */
export function isEvidenceSatisfying(input: EvidenceValidationInput): boolean {
  if (input.evidence.isArchived) return false
  if (!input.evidence.matchesSha(input.expectedSha)) return false
  if (!input.evidence.belongsToRun(input.expectedRunId)) return false
  return true
}

/**
 * Checks whether mandatory evidence exists and is current for all required criteria.
 */
export interface MandatoryEvidenceCheck {
  readonly criterionIds: readonly string[]
  readonly evidenceItems: readonly Evidence[]
  readonly expectedSha: string
  readonly expectedRunId: string
}

export interface CriterionEvidenceStatus {
  readonly criterionId: string
  readonly satisfied: boolean
  readonly evidenceCount: number
  readonly reasons: readonly string[]
}

export function checkMandatoryEvidence(input: MandatoryEvidenceCheck): CriterionEvidenceStatus[] {
  return input.criterionIds.map((criterionId) => {
    const matchingEvidence = input.evidenceItems.filter((e) => e.criterionIds.includes(criterionId))
    const reasons: string[] = []

    if (matchingEvidence.length === 0) {
      reasons.push(`No evidence for criterion ${criterionId}`)
      return { criterionId, satisfied: false, evidenceCount: 0, reasons: Object.freeze(reasons) }
    }

    const currentEvidence = matchingEvidence.filter((e) =>
      isEvidenceCurrent({ evidence: e, expectedSha: input.expectedSha, expectedRunId: input.expectedRunId })
    )

    if (currentEvidence.length === 0) {
      const archived = matchingEvidence.filter((e) => e.isArchived)
      const wrongSha = matchingEvidence.filter((e) => !e.matchesSha(input.expectedSha))
      const wrongRun = matchingEvidence.filter((e) => !e.belongsToRun(input.expectedRunId))

      if (archived.length > 0) reasons.push("Evidence is archived and not current")
      if (wrongSha.length > 0) reasons.push(`Evidence SHA does not match ${input.expectedSha}`)
      if (wrongRun.length > 0) reasons.push(`Evidence belongs to a different run`)
      if (reasons.length === 0) reasons.push("No current evidence available")

      return { criterionId, satisfied: false, evidenceCount: matchingEvidence.length, reasons: Object.freeze(reasons) }
    }

    return { criterionId, satisfied: true, evidenceCount: currentEvidence.length, reasons: Object.freeze([]) }
  })
}
