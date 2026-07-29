/**
 * Evidence service.
 *
 * High-level operations for the evidence domain:
 * - Creating evidence with content immutability
 * - Archiving evidence (content preserved)
 * - Validating evidence binding
 * - Checking mandatory evidence coverage
 */

import { Evidence } from "../domain/evidence"
import { EvidenceNotFoundError } from "../domain/errors"
import { validateEvidenceBinding, checkMandatoryEvidence, type MandatoryEvidenceCheck } from "../policies/evidence-policy"
import type { EvidenceRepository } from "../ports/evidence-repository"
import type { Clock } from "../../common/ports/clock"
import type { IdGenerator } from "../../common/ports/id-generator"

export interface CreateEvidenceInput {
  readonly content: string
  readonly contentType: string
  readonly sha: string
  readonly runId: string
  readonly criterionIds: readonly string[]
}

export class EvidenceService {
  private readonly repository: EvidenceRepository

  constructor(repository: EvidenceRepository) {
    this.repository = repository
  }

  /** Creates immutable evidence. */
  async createEvidence(input: CreateEvidenceInput, clock: Clock, idGenerator: IdGenerator): Promise<Evidence> {
    const evidence = new Evidence({
      id: idGenerator.generate(),
      content: input.content,
      contentType: input.contentType,
      sha: input.sha,
      runId: input.runId,
      criterionIds: input.criterionIds,
      status: "current",
      createdAt: clock.now(),
    })

    await this.repository.saveEvidence(evidence)
    return evidence
  }

  /** Archives evidence (content is preserved). */
  async archiveEvidence(evidenceId: string, clock: Clock): Promise<Evidence> {
    const evidence = await this.repository.getEvidence(evidenceId)
    if (!evidence) {
      throw new EvidenceNotFoundError(evidenceId)
    }

    const archived = evidence.archive(clock.now())
    await this.repository.saveEvidence(archived)
    return archived
  }

  /** Validates evidence binding and returns the evidence if valid. */
  async validateAndGet(evidenceId: string, expectedSha: string, expectedRunId: string): Promise<Evidence> {
    const evidence = await this.repository.getEvidence(evidenceId)
    if (!evidence) {
      throw new EvidenceNotFoundError(evidenceId)
    }

    validateEvidenceBinding({ evidence, expectedSha, expectedRunId })
    return evidence
  }

  /** Checks mandatory evidence coverage for given criteria. */
  async checkEvidenceCoverage(input: MandatoryEvidenceCheck): Promise<ReturnType<typeof checkMandatoryEvidence>> {
    return checkMandatoryEvidence(input)
  }
}
