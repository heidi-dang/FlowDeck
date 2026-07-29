/**
 * Stale detection policy.
 *
 * A verification result is stale when its target SHA does not match the
 * current contract version SHA. Stale results must not satisfy completion
 * requirements.
 */

import type { VerificationResult } from "../domain/verification-result"

export interface StaleCheckInput {
  readonly result: VerificationResult
  readonly currentSha: string
}

/**
 * Returns true if the verification result is stale (its target SHA differs
 * from the current SHA).
 */
export function isResultStale(input: StaleCheckInput): boolean {
  return input.result.targetSha !== input.currentSha
}

/**
 * Returns true if ALL results in a list are stale relative to currentSha.
 */
export function areAllResultsStale(results: readonly VerificationResult[], currentSha: string): boolean {
  return results.length > 0 && results.every((r) => r.targetSha !== currentSha)
}

/**
 * Returns true if ANY result in a list is stale relative to currentSha.
 */
export function hasAnyStaleResult(results: readonly VerificationResult[], currentSha: string): boolean {
  return results.some((r) => r.targetSha !== currentSha)
}
