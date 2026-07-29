/** Base repository class providing shared database access patterns. */
import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../transaction-manager"

export abstract class BaseRepository {
  protected db: Database
  protected tx: TransactionManager

  constructor(db: Database, tx: TransactionManager) {
    this.db = db
    this.tx = tx
  }
}
