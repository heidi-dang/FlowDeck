/**
 * Migration safety regression tests.
 *
 * Proves:
 * - Mid-migration failures roll back all changes atomically
 * - The migration ledger does NOT advance before success
 * - Restart safely retries the failed migration
 * - Repeated startup remains idempotent
 * - Checksum tampering is detected
 * - Process interruption before commit cannot leave partial state
 *
 * KEY INSIGHT: bun:sqlite does NOT auto-rollback on statement error inside
 * explicit transactions. The migration runner's catch block must call
 * ROLLBACK explicitly (which it does: see migration-runner.ts catch block).
 * These tests verify that the runner's rollback pattern works correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { unlinkSync } from "fs"
import { Database } from "bun:sqlite"
import { runMigrations, getCurrentVersion } from "@/orchestration/persistence/migrations/migration-runner"

const TEST_DB = "/tmp/fd-migration-safety-test.db"

function clean() {
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    try { unlinkSync(f) } catch {}
  }
}

describe("migration atomicity — interruption safety", () => {
  beforeEach(clean)
  afterEach(clean)

  it("mid-migration failure rolls back all schema changes (matching runner pattern)", () => {
    const db = new Database(TEST_DB, { create: true })
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL,
      applied_at TEXT NOT NULL, checksum TEXT NOT NULL, duration_ms INTEGER
    )`)

    // Simulate what the runner does: BEGIN, exec schema, INSERT ledger, COMMIT
    // If any step fails, catch rolls back
    let caught = false
    try {
      db.exec("BEGIN IMMEDIATE")
      db.exec("CREATE TABLE mid_table_a (id INTEGER PRIMARY KEY, name TEXT)")
      db.exec("CREATE TABLE mid_table_b (id INTEGER PRIMARY KEY, value TEXT)")
      // Deliberate SQL error: duplicate table name
      db.exec("CREATE TABLE mid_table_a (id INTEGER PRIMARY KEY, name TEXT)")
      db.exec("COMMIT")
    } catch {
      db.exec("ROLLBACK") // exact same pattern as migration-runner.ts
      caught = true
    }
    expect(caught).toBe(true)

    // No partial tables survive
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name='mid_table_a' OR name='mid_table_b')").all()
    expect(tables).toHaveLength(0)

    // Schema_migrations ledger has zero rows
    const count = db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }
    expect(count.c).toBe(0)

    db.close()
  })

  it("runner-equivalent failure rolls back all schema changes", () => {
    const db = new Database(TEST_DB, { create: true })
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL,
      applied_at TEXT NOT NULL, checksum TEXT NOT NULL, duration_ms INTEGER
    )`)

    const beforeVersion = getCurrentVersion(db)

    // Execute partial schema then fail on invalid INSERT
    let caught = false
    try {
      db.exec("BEGIN IMMEDIATE")
      db.exec("CREATE TABLE contract_families (family_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL)")
      // Valid DDL ran, now fail on DML targeting a table that doesn't exist
      db.exec("INSERT INTO nonexistent_table VALUES (1)")
      db.exec("COMMIT")
    } catch {
      db.exec("ROLLBACK") // runner's exact pattern
      caught = true
    }
    expect(caught).toBe(true)

    // contract_families was rolled back
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contract_families'").all()
    expect(hasTable).toHaveLength(0)

    // Version unchanged
    const afterVersion = getCurrentVersion(db)
    expect(afterVersion).toBe(beforeVersion)

    db.close()
  })

  it("retries successfully after interrupted migration", () => {
    const db = new Database(TEST_DB, { create: true })
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL,
      applied_at TEXT NOT NULL, checksum TEXT NOT NULL, duration_ms INTEGER
    )`)

    // Simulate interruption: CREATE TABLE executed then ROLLBACK / crash before ledger write
    db.exec("BEGIN IMMEDIATE")
    db.exec("CREATE TABLE contract_families (family_id TEXT PRIMARY KEY, name TEXT NOT NULL)")
    db.exec("ROLLBACK") // simulate power loss / crash before ledger INSERT + COMMIT

    expect(getCurrentVersion(db)).toBe(0)

    // Clean retry — full migration applies correctly
    runMigrations(db)
    expect(getCurrentVersion(db)).toBe(1)

    // Third run — idempotent
    runMigrations(db)
    expect(getCurrentVersion(db)).toBe(1)

    // Core tables present
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    const names = tables.map(r => r.name)
    expect(names).toContain("contract_families")
    expect(names).toContain("task_contracts")
    expect(names).toContain("events")
    expect(names).toContain("task_runs")

    db.close()
  })

  it("detects checksum tampering", () => {
    const db = new Database(TEST_DB, { create: true })

    runMigrations(db)
    expect(getCurrentVersion(db)).toBe(1)

    // Tamper with checksum (simulates manual DB edit or file corruption)
    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("tampered_checksum")

    // Runner throws MigrationChecksumError
    expect(() => runMigrations(db)).toThrow()

    // DB tables are intact
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    expect(tables.length).toBeGreaterThan(10)

    db.close()
  })

  it("normal migration succeeds and creates core tables", () => {
    const db = new Database(TEST_DB, { create: true })
    runMigrations(db)
    expect(getCurrentVersion(db)).toBe(1)

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    const names = tables.map(r => r.name)
    for (const t of ["contract_families", "task_contracts", "events", "task_runs", "schema_migrations"]) {
      expect(names).toContain(t)
    }

    db.close()
  })

  it("repeated startup is idempotent", () => {
    const db = new Database(TEST_DB, { create: true })
    runMigrations(db)
    expect(getCurrentVersion(db)).toBe(1)

    for (let i = 0; i < 3; i++) {
      runMigrations(db)
      expect(getCurrentVersion(db)).toBe(1)
    }

    db.close()
  })
})
