/**
 * Transaction manager — reusable APIs for all database operations.
 * No feature module may issue raw BEGIN/COMMIT/ROLLBACK.
 *
 * Uses injectable RetryPolicy — no hardcoded timing.
 */

import type Database from "better-sqlite3"
import { ConcurrencyError } from "./errors"
import type { RetryPolicy } from "./retry-policy"
import { createDefaultPolicy } from "./retry-policy"

export interface TransactionManager {
  read<T>(fn: () => T): T
  write<T>(fn: () => T): T
  savepoint<T>(name: string, fn: () => T): T
}

export function createTransactionManager(
  db: Database.Database,
  retryPolicy?: RetryPolicy,
): TransactionManager {
  const policy = retryPolicy ?? createDefaultPolicy()
  const writeTxn = db.transaction((fn: () => unknown) => fn())

  return {
    read<T>(fn: () => T): T {
      return db.transaction(() => fn())()
    },

    write<T>(fn: () => T): T {
      let lastError: Error | null = null

      for (let attempt = 0; attempt < policy.budget.maxAttempts; attempt++) {
        // Deadline check before attempt
        if (policy.budget.deadlineMs > 0 && Date.now() >= policy.budget.deadlineMs) {
          throw lastError ?? new ConcurrencyError(attempt, "Deadline exceeded before attempt")
        }

        try {
          return writeTxn(fn) as T
        } catch (err) {
          const reason = policy.classify(err)
          if (policy.isRetryable(reason) && attempt < policy.budget.maxAttempts - 1) {
            lastError = err as Error
            const delay = policy.strategy.delayMs(attempt)
            // Bounded spin-wait: max 50+100+200=350ms total across all retries
            const deadline = Date.now() + delay
            while (Date.now() < deadline) { /* spin */ }
            continue
          }
          throw err
        }
      }

      throw lastError ?? new ConcurrencyError(policy.budget.maxAttempts, "Max retries exhausted")
    },

    savepoint<T>(name: string, fn: () => T): T {
      const sp = `sp_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`
      try {
        db.exec(`SAVEPOINT ${sp}`)
        const result = fn()
        db.exec(`RELEASE ${sp}`)
        return result
      } catch (err) {
        db.exec(`ROLLBACK TO ${sp}`)
        throw err
      }
    },
  }
}
