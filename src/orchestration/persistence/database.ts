/** Database bootstrap. Called once at application startup. */
import type Database from "better-sqlite3"
import { openConnection, closeConnection } from "./connection"
import { runMigrations } from "./migrations/migration-runner"
import { validateSchema } from "./validation"
import { SchemaValidationError } from "./errors"
import type { DatabaseConfig } from "./configuration"

export function initializeDatabase(config: DatabaseConfig): { db: Database.Database; diagnostics: Record<string, unknown> } {
  const db = openConnection(config)
  if (!config.readonly) {
    runMigrations(db)
    const v = validateSchema(db)
    if (!v.valid) { closeConnection(config.path); throw new SchemaValidationError(v.details) }
    return { db, diagnostics: v.details }
  }
  return { db, diagnostics: {} }
}

export { openConnection, closeConnection, closeAllConnections } from "./connection"
export { getCurrentVersion } from "./migrations/migration-runner"
export { createTransactionManager } from "./transaction-manager"
export type { TransactionManager } from "./transaction-manager"
export type { DatabaseConfig } from "./configuration"
