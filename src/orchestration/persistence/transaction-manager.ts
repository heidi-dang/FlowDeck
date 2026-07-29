/**
 * Transaction manager — reusable APIs for all database operations.
 * No feature module may issue raw BEGIN/COMMIT/ROLLBACK.
 *
 * Transaction callbacks are STRICTLY SYNCHRONOUS. Returning a Promise
 * or thenable causes AsyncTransactionCallbackError and complete rollback.
 *
 * Retry uses an injectable async Scheduler — zero CPU spin.
 */

import type Database from "better-sqlite3"
import { AsyncTransactionCallbackError, ConcurrencyError } from "./errors"
import type { RetryPolicy } from "./retry-policy"
import { createDefaultPolicy } from "./retry-policy"
import type { Scheduler } from "./clock"
import { SystemScheduler } from "./clock"

export interface TransactionManager {
  read<T>(fn: () => T): T
  write<T>(fn: () => T): T
  savepoint<T>(name: string, fn: () => T): T
  /** Async write with retry. The callback is still sync — retry happens between attempts. */
  writeWithRetry<T>(fn: () => T): Promise<T>
}

let savepointCounter = 0

export function createTransactionManager(
  db: Database.Database,
  retryPolicy?: RetryPolicy,
  scheduler?: Scheduler,
): TransactionManager {
  const policy = retryPolicy ?? createDefaultPolicy()
  const sched = scheduler ?? new SystemScheduler()
  const writeTxn = db.transaction((fn: () => unknown) => fn())

  function detectThenable(result: unknown): void {
    if (result !== null && result !== undefined && typeof (result as any).then === 'function') {
      throw new AsyncTransactionCallbackError()
    }
  }

  return {
    read<T>(fn: () => T): T {
      return db.transaction(() => {
        const r = fn()
        detectThenable(r)
        return r
      })()
    },

    write<T>(fn: () => T): T {
      try {
        const result = writeTxn(fn)
        detectThenable(result)
        return result as T
      } catch (err) {
        if (err instanceof AsyncTransactionCallbackError) throw err
        throw err
      }
    },

    async writeWithRetry<T>(fn: () => T): Promise<T> {
      let lastError: Error | null = null

      for (let attempt = 0; attempt < policy.budget.maxAttempts; attempt++) {
        if (policy.clock.monotonic() >= policy.budget.deadlineMs) {
          throw lastError ?? new ConcurrencyError(attempt, "Deadline exceeded")
        }

        try {
          const result = writeTxn(fn)
          detectThenable(result)
          return result as T
        } catch (err) {
          if (err instanceof AsyncTransactionCallbackError) throw err
          const reason = policy.classify(err)
          if (policy.isRetryable(reason) && attempt < policy.budget.maxAttempts - 1) {
            lastError = err as Error
            await sched.delay(policy.strategy.delayMs(attempt))
            continue
          }
          throw err
        }
      }

      throw lastError ?? new ConcurrencyError(policy.budget.maxAttempts, "Retry exhausted")
    },

    savepoint<T>(name: string, fn: () => T): T {
      const id = ++savepointCounter
      const sp = `sp_${name.replace(/[^a-zA-Z0-9_]/g, "_")}_${id}`
      try {
        db.exec(`SAVEPOINT ${sp}`)
        const result = fn()
        detectThenable(result)
        db.exec(`RELEASE ${sp}`)
        return result
      } catch (err) {
        try { db.exec(`ROLLBACK TO ${sp}`) } catch {}
        try { db.exec(`RELEASE ${sp}`) } catch {}
        throw err
      }
    },
  }
}
