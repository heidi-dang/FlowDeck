/**
 * Configurable retry policy for database operations.
 * Replaces hardcoded timing with injectable, testable strategy.
 * Provides deadline-aware, bounded retry with reason classification.
 */

export type RetryReason = "busy" | "constraint" | "deadlock" | "unknown"

export interface RetryStrategy {
  /** Compute delay in ms for a given attempt (0-indexed). */
  delayMs(attempt: number): number
}

export interface RetryBudget {
  maxAttempts: number
  deadlineMs: number
}

export interface RetryPolicy {
  strategy: RetryStrategy
  budget: RetryBudget
  classify(err: unknown): RetryReason
  isRetryable(reason: RetryReason): boolean
}

export const DEFAULT_BASE_MS = 50
export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_BUDGET_MS = 5000

export function createExponentialBackoff(baseMs = DEFAULT_BASE_MS): RetryStrategy {
  return { delayMs(attempt) { return baseMs * Math.pow(2, attempt) } }
}

export function createDefaultBudget(maxAttempts = DEFAULT_MAX_ATTEMPTS, deadlineMs = Date.now() + DEFAULT_BUDGET_MS): RetryBudget {
  return { maxAttempts, deadlineMs }
}

export function createDefaultPolicy(): RetryPolicy {
  return {
    strategy: createExponentialBackoff(),
    budget: createDefaultBudget(),
    classify(err: unknown): RetryReason {
      if (err instanceof Error) {
        const m = err.message.toLowerCase()
        if (m.includes("sqlite_busy") || m.includes("database is locked")) return "busy"
        if (m.includes("unique constraint") || m.includes("foreign key")) return "constraint"
        if (m.includes("deadlock")) return "deadlock"
      }
      return "unknown"
    },
    isRetryable(reason: RetryReason): boolean {
      return reason === "busy" || reason === "deadlock"
    },
  }
}
