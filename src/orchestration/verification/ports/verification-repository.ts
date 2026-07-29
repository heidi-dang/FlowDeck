/**
 * Verification repository port.
 *
 * Defines persistence boundaries for the verification sub-domain.
 */

import type { VerificationRun } from "../domain/verification-run"
import type { VerificationResult } from "../domain/verification-result"

export interface VerificationRepository {
  /** Saves a verification run. */
  saveRun(run: VerificationRun): Promise<void>

  /** Gets a verification run by ID. */
  getRun(runId: string): Promise<VerificationRun | undefined>

  /** Lists runs for a contract version. */
  listRunsByContractVersion(contractVersionId: string): Promise<VerificationRun[]>

  /** Saves a verification result. */
  saveResult(result: VerificationResult): Promise<void>

  /** Gets a verification result by ID. */
  getResult(resultId: string): Promise<VerificationResult | undefined>

  /** Lists all results for a run. */
  listResultsByRun(runId: string): Promise<VerificationResult[]>

  /** Lists all results across runs for a contract version. */
  listResultsByContractVersion(contractVersionId: string): Promise<VerificationResult[]>
}
