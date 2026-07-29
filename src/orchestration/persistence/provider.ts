/**
 * Database Provider — single boundary for database lifecycle, transactions, and migrations.
 * Callers must not construct raw better-sqlite3 databases independently.
 */

import type { TransactionManager } from "./transaction-manager"
import { createTransactionManager } from "./transaction-manager"

export interface DatabaseConfig {
  path: string
  readonly?: boolean
  busyTimeout?: number
}

export interface DatabaseProvider {
  open(config: DatabaseConfig): DatabaseSession
}

export interface DatabaseSession {
  readonly tx: TransactionManager
  readonly config: DatabaseConfig
  close(): void
}

export function createProvider(): DatabaseProvider {
  // Native provider for Node.js — lazy-loaded
  let nativeInit: ((config: DatabaseConfig) => { db: any; session: DatabaseSession }) | null = null

  return {
    open(config: DatabaseConfig): DatabaseSession {
      if (!nativeInit) {
        // Lazy-load better-sqlite3 only when open() is called
        const BetterSqlite3 = require("better-sqlite3")
        nativeInit = (cfg: DatabaseConfig) => {
          const db = new BetterSqlite3(cfg.path, { readonly: cfg.readonly ?? false })
          db.pragma("journal_mode = WAL")
          db.pragma("foreign_keys = ON")
          db.pragma(`busy_timeout = ${cfg.busyTimeout ?? 5000}`)
          db.pragma("synchronous = NORMAL")
          const tx = createTransactionManager(db)
          return { db, session: { tx, config: cfg, close: () => db.close() } }
        }
      }
      return nativeInit(config).session
    },
  }
}
