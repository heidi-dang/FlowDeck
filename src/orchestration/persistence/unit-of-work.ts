/**
 * Unit of Work — one atomic operation spanning multiple repositories.
 * Callbacks are STRICTLY SYNCHRONOUS. Returns Promise for API convenience.
 * Async/thenable callbacks cause AsyncTransactionCallbackError and rollback.
 */

import type Database from "better-sqlite3"
import { createTransactionManager, type TransactionManager } from "./transaction-manager"
import { AsyncTransactionCallbackError } from "./errors"

export interface UnitOfWorkContext {
  db: Database.Database
  tx: TransactionManager
}

export interface UnitOfWork {
  execute<T>(operation: (context: UnitOfWorkContext) => T): Promise<T>
}

export class SqliteUnitOfWork implements UnitOfWork {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  async execute<T>(operation: (context: UnitOfWorkContext) => T): Promise<T> {
    return createTransactionManager(this.db).writeWithRetry(() => {
      const result = operation({ db: this.db, tx: createTransactionManager(this.db) })
      if (result !== null && result !== undefined && typeof (result as any).then === 'function') {
        throw new AsyncTransactionCallbackError()
      }
      return result
    })
  }
}
