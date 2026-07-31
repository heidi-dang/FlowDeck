/**
 * SHA matching policy.
 *
 * Enforces that verification results and evidence must target the exact
 * SHA being verified. A mismatch means the result or evidence belongs to
 * a different revision and cannot satisfy current requirements.
 */

import type { VerificationResult } from "../domain/verification-result"

export interface ShaMatchInput {
  readonly targetSha: string
  readonly requiredSha: string
}

/**
 * Returns true if the target SHA matches the required SHA.
 */
export function shaMatches(input: ShaMatchInput): boolean {
  return input.targetSha === input.requiredSha
}

/**
 * Filters results to only those matching the required SHA.
 */
export function filterResultsBySha(
  results: readonly VerificationResult[],
  requiredSha: string,
): VerificationResult[] {
  return results.filter((r) => r.targetSha === requiredSha)
}

/**
 * Returns true if a result targets a different run (different SHA).
 * Cross-run results must never satisfy completion.
 */
export function isCrossRunResult(result: VerificationResult, expectedRunId: string): boolean {
  return result.runId !== expectedRunId
}
