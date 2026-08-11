import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Database } from "bun:sqlite"
import { runMigrations, getCurrentVersion } from "@/orchestration/persistence/migrations/migration-runner"
import { deterministicCleanup } from "../harness/cleanup"

let currentDir = ""
let TEST_DB = ""

async function clean() {
  if (currentDir) {
    await deterministicCleanup({ dir: currentDir })
    currentDir = ""
    TEST_DB = ""
  }
}

function setupTestDb(): string {
  currentDir = mkdtempSync(join(tmpdir(), "fd-mig-safe-"))
  TEST_DB = join(currentDir, "test.db")
  return TEST_DB
}

describe("migration atomicity — interruption safety", () => {
  beforeEach(setupTestDb)
  afterEach(clean)

  it("mid-migration failure rolls back all schema changes (matching runner pattern)", () => {
    const db = new Database(TEST_DB, { create: true })
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL,
      applied_at TEXT NOT NULL, checksum TEXT NOT NULL, duration_ms INTEGER
    )`)

    let caught = false
    try {
      db.exec("BEGIN IMMEDIATE")
      db.exec("CREATE TABLE mid_table_a (id INTEGER PRIMARY KEY, name TEXT)")
      db.exec("CREATE TABLE mid_table_b (id INTEGER PRIMARY KEY, value TEXT)")
      db.exec("CREATE TABLE mid_table_a (id INTEGER PRIMARY KEY, name TEXT)")
      db.exec("COMMIT")
    } catch {
      db.exec("ROLLBACK")
      caught = true
    }
    expect(caught).toBe(true)

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name='mid_table_a' OR name='mid_table_b')").all()
    expect(tables).toHaveLength(0)

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

    let caught = false
    try {
      db.exec("BEGIN IMMEDIATE")
      db.exec("CREATE TABLE contract_families (family_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL)")
      db.exec("INSERT INTO nonexistent_table VALUES (1)")
      db.exec("COMMIT")
    } catch {
      db.exec("ROLLBACK")
      caught = true
    }
    expect(caught).toBe(true)

    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contract_families'").all()
    expect(hasTable).toHaveLength(0)

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

    db.exec("BEGIN IMMEDIATE")
    db.exec("CREATE TABLE contract_families (family_id TEXT PRIMARY KEY, name TEXT NOT NULL)")
    db.exec("ROLLBACK")

    expect(getCurrentVersion(db)).toBe(0)

    runMigrations(db)
    expect(getCurrentVersion(db)).toBe(7)

    runMigrations(db)
    expect(getCurrentVersion(db)).toBe(7)

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
    expect(getCurrentVersion(db)).toBe(7)

    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("tampered_checksum")

    expect(() => runMigrations(db)).toThrow()

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    expect(tables.length).toBeGreaterThan(10)

    db.close()
  })

  it("normal migration succeeds and creates core tables", () => {
    const db = new Database(TEST_DB, { create: true })
    runMigrations(db)
    expect(getCurrentVersion(db)).toBe(7)

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    const names = tables.map(r => r.name)
    for (const t of ["contract_families", "task_contracts", "events", "task_runs", "schema_migrations", "replays"]) {
      expect(names).toContain(t)
    }

    db.close()
  })

  it("repeated startup is idempotent", () => {
    const db = new Database(TEST_DB, { create: true })
    runMigrations(db)
    expect(getCurrentVersion(db)).toBe(7)

    for (let i = 0; i < 3; i++) {
      runMigrations(db)
      expect(getCurrentVersion(db)).toBe(7)
    }

    db.close()
  })
})
