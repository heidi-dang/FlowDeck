/**
 * Unit of Work — one atomic operation spanning multiple repositories.
 * Callbacks are STRICTLY SYNCHRONOUS. Thenable detection happens INSIDE
 * the transaction boundary via TransactionManager's sync wrappers.
 */

import type { Database } from "bun:sqlite"
import { createTransactionManager, type TransactionManager } from "./transaction-manager"
import type { RetryPolicy } from "./retry-policy"
import type { Scheduler } from "./clock"

export interface UnitOfWork {
  execute<T>(operation: (ctx: UnitOfWorkContext) => T): Promise<T>
}

export interface UnitOfWorkContext {
  readonly tx: TransactionManager
}

export class SqliteUnitOfWork implements UnitOfWork {
  private db: Database
  private policy?: RetryPolicy
  private scheduler?: Scheduler

  constructor(db: Database, policy?: RetryPolicy, scheduler?: Scheduler) {
    this.db = db
    this.policy = policy
    this.scheduler = scheduler
  }

  async execute<T>(operation: (ctx: UnitOfWorkContext) => T): Promise<T> {
    const tx = createTransactionManager(this.db, this.policy, this.scheduler)
    return tx.writeWithRetry(() => {
      return operation({ tx })
    })
  }
}
