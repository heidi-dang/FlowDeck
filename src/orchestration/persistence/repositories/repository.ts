/** Base repository class providing shared database access patterns. */
import type Database from "better-sqlite3"
import type { TransactionManager } from "../transaction-manager"

export abstract class BaseRepository {
  protected db: Database.Database
  protected tx: TransactionManager

  constructor(db: Database.Database, tx: TransactionManager) {
    this.db = db
    this.tx = tx
  }
}
