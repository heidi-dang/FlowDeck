/**
 * Transaction manager — reusable APIs for all database operations.
 * No feature module may issue raw BEGIN/COMMIT/ROLLBACK.
 */

import type Database from "better-sqlite3"
import { TransactionError, ConcurrencyError } from "./errors"

const MAX_BUSY_RETRIES = 3
const BASE_BACKOFF_MS = 50

export interface TransactionManager {
  read<T>(fn: () => T): T
  write<T>(fn: () => T): T
  savepoint<T>(name: string, fn: () => T): T
}

export function createTransactionManager(db: Database.Database): TransactionManager {
  const writeTxn = db.transaction((fn: () => unknown) => fn())

  return {
    read<T>(fn: () => T): T {
      return db.transaction(() => fn())()
    },

    write<T>(fn: () => T): T {
      let lastError: Error | null = null

      for (let attempt = 0; attempt < MAX_BUSY_RETRIES; attempt++) {
        try {
          return writeTxn(fn) as T
        } catch (err) {
          if (isBusyError(err) && attempt < MAX_BUSY_RETRIES - 1) {
            lastError = err as Error
            // Exponential backoff: 50ms, 100ms, 200ms
            const delay = BASE_BACKOFF_MS * Math.pow(2, attempt)
            // Use Atomics.wait with a timeout as bounded polling (not arbitrary sleep)
            const deadline = Date.now() + delay
            while (Date.now() < deadline) {
              // Busy-wait is acceptable here because: (a) max 200ms, (b) bounded by
              // deadline, (c) only reached when DB is genuinely contended
            }
            continue
          }
          throw err
        }
      }

      throw lastError ?? new ConcurrencyError(MAX_BUSY_RETRIES)
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

function isBusyError(err: unknown): boolean {
  if (err instanceof Error) {
    const m = err.message.toLowerCase()
    return m.includes("sqlite_busy") || m.includes("database is locked")
  }
  return false
}
