/**
 * In-memory verification repository.
 *
 * Used for testing until Dev 1's persistence layer is available.
 */

import type { VerificationRun } from "../domain/verification-run"
import type { VerificationResult } from "../domain/verification-result"
import type { VerificationRepository } from "../ports/verification-repository"

export class InMemoryVerificationRepository implements VerificationRepository {
  private readonly runs: Map<string, VerificationRun> = new Map()
  private readonly results: Map<string, VerificationResult> = new Map()

  async saveRun(run: VerificationRun): Promise<void> {
    this.runs.set(run.id, run)
  }

  async getRun(runId: string): Promise<VerificationRun | undefined> {
    return this.runs.get(runId)
  }

  async listRunsByContractVersion(contractVersionId: string): Promise<VerificationRun[]> {
    return Array.from(this.runs.values()).filter((r) => r.contractVersionId === contractVersionId)
  }

  async saveResult(result: VerificationResult): Promise<void> {
    this.results.set(result.id, result)
  }

  async getResult(resultId: string): Promise<VerificationResult | undefined> {
    return this.results.get(resultId)
  }

  async listResultsByRun(runId: string): Promise<VerificationResult[]> {
    return Array.from(this.results.values()).filter((r) => r.runId === runId)
  }

  async listResultsByContractVersion(_contractVersionId: string): Promise<VerificationResult[]> {
    return Array.from(this.results.values())
  }

  clear(): void {
    this.runs.clear()
    this.results.clear()
  }
}
