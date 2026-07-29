/**
 * Evidence repository port.
 */

import type { Evidence } from "../domain/evidence"
import type { EvidenceLink } from "../domain/evidence-link"

export interface EvidenceRepository {
  /** Saves evidence (insert or update status). */
  saveEvidence(evidence: Evidence): Promise<void>

  /** Gets evidence by ID. */
  getEvidence(evidenceId: string): Promise<Evidence | undefined>

  /** Lists all evidence for a run. */
  listEvidenceByRun(runId: string): Promise<Evidence[]>

  /** Lists all evidence for a criterion. */
  listEvidenceByCriterion(criterionId: string): Promise<Evidence[]>

  /** Lists all evidence for a SHA. */
  listEvidenceBySha(sha: string): Promise<Evidence[]>

  /** Saves an evidence link. */
  saveLink(link: EvidenceLink): Promise<void>

  /** Lists links for an evidence item. */
  listLinksByEvidence(evidenceId: string): Promise<EvidenceLink[]>
}
