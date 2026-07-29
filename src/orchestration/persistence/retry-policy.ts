/** Configurable retry policy. Uses injectable Clock and Scheduler — no CPU spin. */

import type { Clock, Scheduler } from "./clock"
import { SystemClock, SystemScheduler } from "./clock"

export type RetryReason = "busy" | "constraint" | "deadlock" | "unknown"

export interface RetryStrategy {
  delayMs(attempt: number): number
}

export interface RetryBudget {
  maxAttempts: number
  deadlineMs: number
}

export interface RetryPolicy {
  strategy: RetryStrategy
  budget: RetryBudget
  clock: Clock
  scheduler: Scheduler
  classify(err: unknown): RetryReason
  isRetryable(reason: RetryReason): boolean
}

export const DEFAULT_BASE_MS = 50
export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_DEADLINE_MS = 5000

export function createExponentialBackoff(baseMs = DEFAULT_BASE_MS): RetryStrategy {
  return { delayMs(attempt) { return baseMs * Math.pow(2, attempt) } }
}

export function createDefaultPolicy(clock?: Clock, scheduler?: Scheduler): RetryPolicy {
  const c = clock ?? new SystemClock()
  return {
    strategy: createExponentialBackoff(),
    budget: { maxAttempts: DEFAULT_MAX_ATTEMPTS, deadlineMs: c.monotonic() + DEFAULT_DEADLINE_MS },
    clock: c,
    scheduler: scheduler ?? new SystemScheduler(),
    classify(err: unknown): RetryReason {
      if (err instanceof Error) {
        const m = err.message.toLowerCase()
        if (m.includes("sqlite_busy") || m.includes("database is locked")) return "busy"
        if (m.includes("unique constraint") || m.includes("foreign key") || m.includes("check constraint")) return "constraint"
        if (m.includes("deadlock")) return "deadlock"
      }
      return "unknown"
    },
    isRetryable(reason: RetryReason): boolean {
      return reason === "busy" || reason === "deadlock"
    },
  }
}
