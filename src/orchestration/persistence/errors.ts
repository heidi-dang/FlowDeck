/** Typed persistence errors for clear diagnostic categories. */

export class PersistenceError extends Error {
  constructor(message: string) { super(message); this.name = "PersistenceError" }
}

export class MigrationError extends PersistenceError {
  constructor(message: string) { super(message); this.name = "MigrationError" }
}

export class MigrationChecksumError extends MigrationError {
  constructor(version: number, expected: string, actual: string) {
    super(`Migration v${version} checksum mismatch. Expected: ${expected}, got: ${actual}. Manual intervention required.`)
    this.name = "MigrationChecksumError"
  }
}

export class SchemaValidationError extends PersistenceError {
  public categories: Record<string, string[]>

  constructor(categories: Record<string, string[]>) {
    const parts = Object.entries(categories).filter(([, v]) => v.length > 0)
    super(parts.map(([k, v]) => `${k} (${v.length}): ${v.join(", ")}`).join("\n"))
    this.name = "SchemaValidationError"
    this.categories = categories
  }
}

export class TransactionError extends PersistenceError {
  constructor(message: string) { super(message); this.name = "TransactionError" }
}

export class ConcurrencyError extends PersistenceError {
  constructor(attempts: number) {
    super(`Operation failed after ${attempts} retries due to concurrent access`)
    this.name = "ConcurrencyError"
  }
}
