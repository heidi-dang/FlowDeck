/**
 * In-memory evidence repository.
 *
 * Used for testing until Dev 1's persistence layer is available.
 */

import type { Evidence } from "../domain/evidence"
import type { EvidenceLink } from "../domain/evidence-link"
import type { EvidenceRepository } from "../ports/evidence-repository"

export class InMemoryEvidenceRepository implements EvidenceRepository {
  private readonly evidence: Map<string, Evidence> = new Map()
  private readonly links: EvidenceLink[] = []

  async saveEvidence(evidence: Evidence): Promise<void> {
    this.evidence.set(evidence.id, evidence)
  }

  async getEvidence(evidenceId: string): Promise<Evidence | undefined> {
    return this.evidence.get(evidenceId)
  }

  async listEvidenceByRun(runId: string): Promise<Evidence[]> {
    return Array.from(this.evidence.values()).filter((e) => e.runId === runId)
  }

  async listEvidenceByCriterion(criterionId: string): Promise<Evidence[]> {
    return Array.from(this.evidence.values()).filter((e) => e.criterionIds.includes(criterionId))
  }

  async listEvidenceBySha(sha: string): Promise<Evidence[]> {
    return Array.from(this.evidence.values()).filter((e) => e.sha === sha)
  }

  async saveLink(link: EvidenceLink): Promise<void> {
    this.links.push(link)
  }

  async listLinksByEvidence(evidenceId: string): Promise<EvidenceLink[]> {
    return this.links.filter((l) => l.evidenceId === evidenceId)
  }

  clear(): void {
    this.evidence.clear()
    this.links.length = 0
  }
}
