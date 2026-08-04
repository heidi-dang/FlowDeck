/**
 * Verification Result Types
 *
 * Captures the outcome of a verification plan execution, including
 * timing information and detailed check results.
 */

export type CheckStatus = "passed" | "failed" | "skipped"

export interface CheckResult {
  readonly checkId: string
  readonly status: CheckStatus
  readonly output?: string
  readonly error?: string
  readonly duration: number
  readonly timestamp: Date
}

export type VerificationStatus = "passed" | "failed" | "partial"

export interface VerificationResult {
  readonly planId: string
  readonly status: VerificationStatus
  readonly checkResults: CheckResult[]
  readonly startTime: Date
  readonly endTime: Date
  readonly duration: number
}
