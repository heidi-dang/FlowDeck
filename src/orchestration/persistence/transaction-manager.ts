/**
 * Transaction manager — reusable APIs for all database operations.
 *
 * CRITICAL: Thenable detection happens INSIDE db.transaction(), BEFORE the
 * driver commits. If the callback returns a thenable, the error is thrown
 * inside the active transaction, triggering automatic rollback.
 *
 * Retry uses injectable async Scheduler — zero CPU spin.
 */

import type { Database } from "bun:sqlite"
import { AsyncTransactionCallbackError, ConcurrencyError, PersistenceError } from "./errors"
import type { RetryPolicy } from "./retry-policy"
import { createDefaultPolicy } from "./retry-policy"
import type { Scheduler } from "./clock"
import { SystemScheduler } from "./clock"

export interface TransactionManager {
  read<T>(fn: () => T): T
  write<T>(fn: () => T): T
  writeImmediate<T>(fn: () => T): T
  writeWithRetry<T>(fn: () => T): Promise<T>
  savepoint<T>(name: string, fn: () => T): T
}

function assertSync<T>(result: T): void {
  if (result !== null && result !== undefined && typeof (result as any).then === 'function') {
    throw new AsyncTransactionCallbackError()
  }
}

export class SavepointCleanupError extends PersistenceError {
  constructor(
    readonly operationError: unknown,
    readonly rollbackError?: unknown,
    readonly releaseError?: unknown,
  ) { super("Savepoint operation failed and cleanup encountered errors"); this.name = "SavepointCleanupError" }

}

export function createTransactionManager(
  db: Database,
  retryPolicy?: RetryPolicy,
  scheduler?: Scheduler,
): TransactionManager {
  const policy = retryPolicy ?? createDefaultPolicy()
  const sched = scheduler ?? new SystemScheduler()
  let instanceSpCounter = 0

  function computeDelay(attempt: number): number {
    const d = policy.strategy.delayMs(attempt)
    const remaining = policy.budget.deadlineMs - policy.clock.monotonic()
    return d > remaining ? 0 : d
  }

  return {
    read<T>(fn: () => T): T {
      const txn = db.transaction(() => { const r = fn(); assertSync(r); return r })
      return txn()
    },

    write<T>(fn: () => T): T {
      const txn = db.transaction(() => { const r = fn(); assertSync(r); return r })
      return txn()
    },

    writeImmediate<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE")
      try {
        const txn = db.transaction(() => { const r = fn(); assertSync(r); return r })
        return txn()
      } finally {
        // Transaction wrapper handles COMMIT/ROLLBACK
      }
    },

    async writeWithRetry<T>(fn: () => T): Promise<T> {
      let lastError: Error | null = null
      for (let attempt = 0; attempt < policy.budget.maxAttempts; attempt++) {
        if (policy.clock.monotonic() >= policy.budget.deadlineMs) {
          throw lastError ?? new PersistenceError("Deadline exceeded")
        }
        try {
          const txn = db.transaction(() => { const r = fn(); assertSync(r); return r })
          return txn()
        } catch (err) {
          if (err instanceof AsyncTransactionCallbackError) throw err
          const reason = policy.classify(err)
          if (!policy.isRetryable(reason) || attempt >= policy.budget.maxAttempts - 1) throw err
          const delayMs = computeDelay(attempt)
          if (delayMs <= 0) throw new PersistenceError("Deadline exceeded: delay exceeds budget")
          lastError = err as Error
          await sched.delay(delayMs)
        }
      }
      throw lastError ?? new ConcurrencyError(policy.budget.maxAttempts, "Retry exhausted")
    },

    savepoint<T>(name: string, fn: () => T): T {
      const id = ++instanceSpCounter
      const sp = `sp_${name.replace(/[^a-zA-Z0-9_]/g, "_")}_${id}`.slice(0, 64)
      let opErr: unknown; let rbErr: unknown; let rlErr: unknown
      try {
        db.exec(`SAVEPOINT ${sp}`)
        const r = fn(); assertSync(r)
        db.exec(`RELEASE ${sp}`)
        return r
      } catch (err) {
        opErr = err
        try { db.exec(`ROLLBACK TO ${sp}`) } catch (e) { rbErr = e }
        try { db.exec(`RELEASE ${sp}`) } catch (e) { rlErr = e }
        if (rbErr || rlErr) throw new SavepointCleanupError(opErr, rbErr, rlErr)
        throw err
      }
    },
  }
}
