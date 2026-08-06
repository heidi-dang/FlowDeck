/**
 * Canonical evidence import adapter.
 *
 * The ONLY sanctioned path for importing Better Harness evidence into the
 * canonical orchestration evidence store. It is explicit and bound to an
 * exact canonical run + SHA, so imported evidence can never be attributed to
 * the wrong run or revision.
 *
 * This adapter writes ONLY through the canonical EvidenceRepository port
 * (via EvidenceService). It never writes to canonical tables directly
 * (task_runs, assignments, completion_decisions, events, event_outbox) and
 * never mutates harness JSON stores. It is a read-only consumer of the
 * harness report and a write-only producer into the canonical evidence store.
 */

import { EvidenceService, type CreateEvidenceInput } from "../../orchestration/evidence/services/evidence-service"
import type { EvidenceRepository } from "../../orchestration/evidence/ports/evidence-repository"
import type { Clock } from "../../orchestration/common/ports/clock"
import type { IdGenerator } from "../../orchestration/common/ports/id-generator"
import type { HarnessReport } from "../contracts/report"

export interface CanonicalEvidenceImportInput {
  /** The canonical run this evidence belongs to (NOT a harness run_ id). */
  readonly runId: string
  /** The exact source revision (SHA) the evidence was collected against. */
  readonly sha?: string
  /** The Better Harness report whose findings' evidence will be imported. */
  readonly report: HarnessReport
  /** Optional criterion IDs to bind imported evidence to. */
  readonly criterionIds?: readonly string[]
}

export interface CanonicalEvidenceImportSummary {
  readonly runId: string
  readonly sha: string
  readonly importedEvidenceCount: number
  readonly importedFindingCount: number
  readonly contentType: string
}

/**
 * Imports Better Harness evidence into the canonical evidence store, bound to
 * an exact canonical run + SHA. Each harness finding's evidence items become
 * canonical Evidence records. The harness run id is never used as the
 * canonical run id — the caller must supply the canonical runId explicitly.
 */
export class CanonicalEvidenceImportAdapter {
  private readonly evidenceService: EvidenceService
  private readonly clock: Clock
  private readonly idGenerator: IdGenerator

  constructor(
    repository: EvidenceRepository,
    clock: Clock,
    idGenerator: IdGenerator,
  ) {
    this.evidenceService = new EvidenceService(repository)
    this.clock = clock
    this.idGenerator = idGenerator
  }

  /**
   * Import all evidence from a Better Harness report into the canonical
   * evidence store, bound to the given canonical runId and SHA.
   *
   * @throws if the report has no sourceRevision and no sha is provided, or if
   *   the provided sha does not match the report's sourceRevision.
   */
  async importReport(input: CanonicalEvidenceImportInput): Promise<CanonicalEvidenceImportSummary> {
    const sha = input.sha ?? input.report.sourceRevision
    if (!sha) {
      throw new Error(
        "[canonical-evidence-adapter] Cannot import harness evidence without a SHA. " +
          "Provide `sha` explicitly or ensure the harness report has a sourceRevision.",
      )
    }
    if (input.report.sourceRevision && input.sha && input.report.sourceRevision !== input.sha) {
      throw new Error(
        `[canonical-evidence-adapter] SHA mismatch: report sourceRevision=${input.report.sourceRevision} ` +
          `but import sha=${input.sha}. Evidence must be bound to the exact revision it was collected against.`,
      )
    }

    const criterionIds = input.criterionIds ?? []
    let importedEvidenceCount = 0
    let importedFindingCount = 0

    for (const finding of input.report.findings) {
      for (const evidence of finding.evidence) {
        const createInput: CreateEvidenceInput = {
          content: evidence.summary,
          contentType: `better-harness/${evidence.category}`,
          sha,
          runId: input.runId,
          criterionIds,
        }
        await this.evidenceService.createEvidence(createInput, this.clock, this.idGenerator)
        importedEvidenceCount++
      }
      if (finding.evidence.length > 0) {
        importedFindingCount++
      }
    }

    return {
      runId: input.runId,
      sha,
      importedEvidenceCount,
      importedFindingCount,
      contentType: "harness",
    }
  }
}