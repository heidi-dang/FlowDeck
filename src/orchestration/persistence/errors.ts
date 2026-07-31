/** Typed persistence errors with machine-readable codes. No SQLite internals leak. */
export class PersistenceError extends Error {
  constructor(message: string) { super(message); this.name = "PersistenceError" }
}
export class MigrationError extends PersistenceError {
  constructor(message: string) { super(message); this.name = "MigrationError" }
}
export class MigrationChecksumError extends MigrationError {
  _ignoreParams?: never
  public version: number
  constructor(version: number, _expected: string, _actual: string) {
    super(`Migration v${version} checksum mismatch`); this.version = version; this.name = "MigrationChecksumError"
  }
}
export class SchemaValidationError extends PersistenceError {
  public categories: Record<string, unknown[]>
  public recovery: string[]
  constructor(c: Record<string, unknown[]>, r: string[]) { super(Object.entries(c).filter(([,v])=>v.length>0).map(([k,v])=>`${k}: ${v.length}`).join("; ")); this.categories = c; this.recovery = r; this.name = "SchemaValidationError" }
}
export class TransactionError extends PersistenceError {
  constructor(message: string) { super(message); this.name = "TransactionError" }
}
export class AsyncTransactionCallbackError extends TransactionError {
  constructor() { super("Transaction callback returned a Promise or thenable. Transaction callbacks must be synchronous."); this.name = "AsyncTransactionCallbackError" }
}
export class ConcurrencyError extends PersistenceError {
  public attempts: number; public reason: string
  constructor(attempts: number, reason: string) { super(`Concurrency conflict after ${attempts}: ${reason}`); this.attempts = attempts; this.reason = reason; this.name = "ConcurrencyError" }
}
export class RepositoryError extends PersistenceError {
  constructor(message: string) { super(message); this.name = "RepositoryError" }
}
