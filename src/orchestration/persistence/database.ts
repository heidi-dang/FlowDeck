/** Database bootstrap. Called once at application startup. */
import type { Database } from "bun:sqlite"
import { openConnection, closeConnection } from "./connection"
import { runMigrations } from "./migrations/migration-runner"
import { validateSchema } from "./validation"
import { SchemaValidationError } from "./errors"
import type { DatabaseConfig } from "./configuration"

export function initializeDatabase(config: DatabaseConfig): { db: Database; diagnostics: ReturnType<typeof validateSchema> } {
  const db = openConnection(config)
  if (!config.readonly) {
    runMigrations(db)
    const v = validateSchema(db)
    if (!v.valid) {
      closeConnection(config.path)
      const cats: Record<string, unknown[]> = {}
      for (const item of v.items) {
        if (!cats[item.severity]) cats[item.severity] = []
        cats[item.severity].push(item.detail)
      }
      throw new SchemaValidationError(cats, v.items.filter(i => i.recovery).map(i => i.recovery!))
    }
    return { db, diagnostics: {} as any }
  }
  return { db, diagnostics: {} as any }
}
export { openConnection, closeConnection, closeAllConnections } from "./connection"
export { getCurrentVersion } from "./migrations/migration-runner"
export { createTransactionManager } from "./transaction-manager"
export type { TransactionManager } from "./transaction-manager"
export type { DatabaseConfig } from "./configuration"
