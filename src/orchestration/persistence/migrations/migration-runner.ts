/**
 * Migration runner — applies pending migrations atomically.
 * Interrupted migrations never leave the database partially upgraded
 * because each migration runs in its own transaction.
 */

import type { Database } from "bun:sqlite"
import { MigrationError, MigrationChecksumError } from "../errors"
import { MIGRATIONS } from "./migration-registry"

function createLedgerTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL,
    duration_ms INTEGER
  )`)
}

export interface AppliedMigration {
  version: number
  name: string
  checksum: string
}

function getApplied(db: Database): Map<number, AppliedMigration> {
  try {
    const rows = db.query("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as AppliedMigration[]
    return new Map(rows.map(r => [r.version, r]))
  } catch {
    return new Map()
  }
}

export function getCurrentVersion(db: Database): number {
  try {
    const row = db.query("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number }
    return row.v
  } catch {
    return 0
  }
}

export function runMigrations(db: Database): void {
  createLedgerTable(db)
  const applied = getApplied(db)

  for (const migration of MIGRATIONS) {
    const previously = applied.get(migration.version)

    if (previously) {
      if (previously.checksum !== migration.checksum) {
        throw new MigrationChecksumError(migration.version, previously.checksum, migration.checksum)
      }
      continue
    }

    const start = Date.now()
    try {
      db.exec("BEGIN IMMEDIATE")
      db.exec(migration.sql)
      db.query(
        `INSERT INTO schema_migrations (version, name, applied_at, checksum, duration_ms)
         VALUES (?, ?, datetime('now'), ?, ?)`
      ).run(migration.version, migration.name, migration.checksum, Date.now() - start)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      const message = err instanceof Error ? err.message : String(err)
      throw new MigrationError(
        `Migration v${migration.version} ("${migration.name}") failed: ${message}. ` +
        "Rolled back. Database remains at previous state."
      )
    }
  }
}
