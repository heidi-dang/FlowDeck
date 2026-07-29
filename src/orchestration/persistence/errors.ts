/** Typed persistence errors with machine-readable codes. No SQLite internals leak to domain callers. */

export class PersistenceError extends Error {
  constructor(message: string) { super(message); this.name = "PersistenceError" }
}

export class MigrationError extends PersistenceError {
  constructor(message: string) { super(message); this.name = "MigrationError" }
}

export class MigrationChecksumError extends MigrationError {
  public version: number
  constructor(version: number, expected: string, actual: string) {
    super(`Migration v${version} checksum mismatch`)
    this.version = version
    this.name = "MigrationChecksumError"
  }
}

export class MigrationDuplicateError extends MigrationError {
  public version: number
  constructor(version: number) {
    super(`Duplicate migration v${version} detected`)
    this.version = version
    this.name = "MigrationDuplicateError"
  }
}

export class MigrationInterruptedError extends MigrationError {
  public version: number
  constructor(version: number, cause: string) {
    super(`Migration v${version} was interrupted: ${cause}`)
    this.version = version
    this.name = "MigrationInterruptedError"
  }
}

export class SchemaValidationError extends PersistenceError {
  public categories: Record<string, unknown[]>
  public recovery: string[]

  constructor(categories: Record<string, unknown[]>, recovery: string[]) {
    const parts = Object.entries(categories).filter(([, v]) => v.length > 0)
    super(parts.map(([k, v]) => `${k}: ${v.length} issue(s)`).join("; "))
    this.categories = categories
    this.recovery = recovery
    this.name = "SchemaValidationError"
  }
}

export class TransactionError extends PersistenceError {
  constructor(message: string) { super(message); this.name = "TransactionError" }
}

export class ConcurrencyError extends PersistenceError {
  public attempts: number
  public reason: string
  constructor(attempts: number, reason: string) {
    super(`Concurrency conflict after ${attempts} attempt(s): ${reason}`)
    this.attempts = attempts
    this.reason = reason
    this.name = "ConcurrencyError"
  }
}

export class RepositoryError extends PersistenceError {
  constructor(message: string) { super(message); this.name = "RepositoryError" }
}
