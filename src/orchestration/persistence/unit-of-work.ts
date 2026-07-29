/**
 * Unit of Work — one atomic operation spanning multiple repositories.
 * Backed by TransactionManager. Domain services never manually begin transactions.
 */

import type { TransactionManager } from "./transaction-manager"
import { createTransactionManager } from "./transaction-manager"
import type Database from "better-sqlite3"

export interface UnitOfWork {
  execute<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T>
}

export interface UnitOfWorkContext {
  /** Run operations within the current transaction. All succeed or all roll back. */
  // Context is implicit via the shared TransactionManager — repositories share the same db/tx
}

export class SqliteUnitOfWork implements UnitOfWork {
  private db: Database.Database
  private tx: TransactionManager

  constructor(db: Database.Database, tx?: TransactionManager) {
    this.db = db
    this.tx = tx ?? createTransactionManager(db)
  }

  async execute<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    return this.tx.write(async () => {
      return fn({})
    })
  }
}
