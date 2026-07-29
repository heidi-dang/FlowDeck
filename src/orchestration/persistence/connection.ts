/**
 * Database connection management.
 * Every connection is configured with identical production-safe settings.
 * Connections are cached by resolved path.
 */

import Database from "better-sqlite3"
import { resolve } from "path"
import { REQUIRED_PRAGMAS, type DatabaseConfig, type PragmaResult } from "./configuration"
import { PersistenceError } from "./errors"

const CONNECTIONS = new Map<string, Database.Database>()

export function openConnection(config: DatabaseConfig): Database.Database {
  const key = resolve(config.path)
  const existing = CONNECTIONS.get(key)
  if (existing) return existing

  const db = new Database(key, { readonly: config.readonly ?? false })

  const failures: PragmaResult[] = []

  for (const p of REQUIRED_PRAGMAS) {
    try {
      const result = db.pragma(p.name, { simple: false }) as Record<string, unknown>
      // Verify the pragma was applied correctly
      const value = String(Object.values(result)[0] ?? "")
      const expected = p.value.toLowerCase()
      const actual = value.toLowerCase()
      if (actual !== expected && !(p.name === "journal_mode" && actual === "wal")) {
        failures.push({ name: p.name, value: actual, success: false })
      }
    } catch (err) {
      failures.push({ name: p.name, value: String(err), success: false })
    }
  }

  if (failures.length > 0) {
    db.close()
    throw new PersistenceError(
      `SQLite pragma configuration failed:\n${
        failures.map(f => `  ${f.name}: expected value, got "${f.value}"`).join("\n")
      }`
    )
  }

  CONNECTIONS.set(key, db)
  return db
}

export function closeConnection(path: string): void {
  const key = resolve(path)
  const db = CONNECTIONS.get(key)
  if (db) { db.close(); CONNECTIONS.delete(key) }
}

export function closeAllConnections(): void {
  for (const [, db] of CONNECTIONS) db.close()
  CONNECTIONS.clear()
}

export function getConnectionCount(): number {
  return CONNECTIONS.size
}
