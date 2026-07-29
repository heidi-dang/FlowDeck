import { describe, it, expect, beforeEach, afterEach } from "bun:test"; void Database; void closeAllConnections; void existsSync;
import { unlinkSync, existsSync } from "fs"
import { Database } from "bun:sqlite"
import { openConnection, closeConnection, closeAllConnections } from "../connection"
import { initializeDatabase } from "../database"
import { runMigrations, getCurrentVersion } from "../migrations/migration-runner"
import { createTransactionManager } from "../transaction-manager"
import { validateSchema } from "../validation"

const TEST_DB = "/tmp/flowdeck-persist-test.db"

function clean() {
  closeConnection(TEST_DB)
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    try { unlinkSync(f) } catch {}
  }
}

describe("Database bootstrap", () => {
  beforeEach(clean)
  afterEach(clean)

  it("creates database with pragmas applied", () => {
    const db = openConnection({ path: TEST_DB })
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
    expect(fk.foreign_keys).toBe(1)
    const jm = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
    expect(jm.journal_mode.toLowerCase()).toBe("wal")
  })

  it("reuses same connection for same path", () => {
    const db1 = openConnection({ path: TEST_DB })
    const db2 = openConnection({ path: TEST_DB })
    expect(db1).toBe(db2)
  })

  it("initializeDatabase runs migrations and validates", () => {
    const { db } = initializeDatabase({ path: TEST_DB })
    expect(getCurrentVersion(db)).toBeGreaterThanOrEqual(1)
  })
})

describe("Migrations", () => {
  beforeEach(clean)
  afterEach(clean)

  it("applies initial schema", () => {
    const db = openConnection({ path: TEST_DB })
    runMigrations(db)
    expect(getCurrentVersion(db)).toBe(1)
  })

  it("creates required tables (50+)", () => {
    const db = openConnection({ path: TEST_DB })
    runMigrations(db)
    const count = (db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name!='sqlite_sequence'").get() as { c: number }).c
    expect(count).toBeGreaterThanOrEqual(50)
  })

  it("creates required triggers (30+)", () => {
    const db = openConnection({ path: TEST_DB })
    runMigrations(db)
    const count = (db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger'").get() as { c: number }).c
    expect(count).toBeGreaterThanOrEqual(30)
  })

  it("is idempotent", () => {
    const db = openConnection({ path: TEST_DB })
    runMigrations(db)
    const v1 = getCurrentVersion(db)
    runMigrations(db)
    expect(getCurrentVersion(db)).toBe(v1)
  })

  it("rejects checksum mismatch", () => {
    const db = openConnection({ path: TEST_DB })
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT, checksum TEXT, duration_ms INTEGER)")
    db.prepare("INSERT INTO schema_migrations VALUES (1, 'bad', datetime('now'), 'badchecksum', 0)").run()
    expect(() => runMigrations(db)).toThrow("checksum mismatch")
  })
})

describe("Transaction manager", () => {
  beforeEach(clean)
  afterEach(clean)

  it("commits write transactions", () => {
    const { db } = initializeDatabase({ path: TEST_DB })
    const tx = createTransactionManager(db)
    tx.write(() => {
      db.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES (?, 'test', 'test', datetime('now'))").run("fam-t1")
    })
    const c = (db.prepare("SELECT COUNT(*) AS c FROM contract_families").get() as { c: number }).c
    expect(c).toBe(1)
  })

  it("rolls back on error", () => {
    const { db } = initializeDatabase({ path: TEST_DB })
    const tx = createTransactionManager(db)
    expect(() => tx.write(() => {
      db.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES (?, 'roll', 'test', datetime('now'))").run("fam-t2")
      throw new Error("force")
    })).toThrow()
    const c = (db.prepare("SELECT COUNT(*) AS c FROM contract_families").get() as { c: number }).c
    expect(c).toBe(0)
  })

  it("nested savepoint rolls back independently", () => {
    const { db } = initializeDatabase({ path: TEST_DB })
    const tx = createTransactionManager(db)
    tx.write(() => {
      db.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES (?, 'outer', 'test', datetime('now'))").run("fam-t3")
      expect(() => tx.savepoint("inner", () => {
        db.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES (?, 'inner', 'test', datetime('now'))").run("fam-t4")
        throw new Error("inner")
      })).toThrow()
    })
    const c = (db.prepare("SELECT COUNT(*) AS c FROM contract_families").get() as { c: number }).c
    expect(c).toBe(1)
  })
})

describe("Schema validation", () => {
  beforeEach(clean)
  afterEach(clean)

  it("passes on correctly migrated database", () => {
    const { db } = initializeDatabase({ path: TEST_DB })
    const r = validateSchema(db)
    expect(r.valid).toBe(true)
    expect(r.machine.fkViolations).toHaveLength(0)
    expect(r.machine.missingTables).toHaveLength(0)
    expect(r.machine.missingTriggers).toHaveLength(0)
    expect(r.tableCount).toBeGreaterThanOrEqual(50)
    expect(r.triggerCount).toBeGreaterThanOrEqual(30)
  })

  it("fails on empty database", () => {
    const db = openConnection({ path: TEST_DB })
    const r = validateSchema(db)
    expect(r.valid).toBe(false)
    expect(r.machine.missingTables.length).toBeGreaterThan(0)
  })
})

describe("PRAGMA verification", () => {
  beforeEach(clean)
  afterEach(clean)

  it("foreign_key_check returns empty", () => {
    const { db } = initializeDatabase({ path: TEST_DB })
    const fk = db.prepare("PRAGMA foreign_key_check").all()
    expect(fk).toHaveLength(0)
  })

  it("integrity_check returns ok", () => {
    const { db } = initializeDatabase({ path: TEST_DB })
    const i = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
    expect(i.integrity_check).toBe("ok")
  })

  it("schema inventory matches expectations", () => {
    const { db } = initializeDatabase({ path: TEST_DB })
    const inventory = db.prepare("SELECT type, COUNT(*) AS cnt FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type").all() as { type: string; cnt: number }[]
    for (const row of inventory) {
      expect(row.cnt).toBeGreaterThan(0)
    }
  })
})

describe("Repository: Events", () => {
  beforeEach(clean)
  afterEach(clean)

  it("appends events with aggregate version tracking", () => {
    const { db } = initializeDatabase({ path: TEST_DB })
    const tx = createTransactionManager(db)
    const { EventsRepository } = require("../repositories/event")
    const repo = new EventsRepository(db, tx)

    const e1 = repo.append({ eventId: "e1", eventType: "Test", aggregateType: "run", aggregateId: "r1", aggregateVersion: 1, data: "{}" })
    expect(e1.globalSequence).toBeGreaterThan(0)
    expect(e1.aggregateVersion).toBe(1)

    const e2 = repo.append({ eventId: "e2", eventType: "Test", aggregateType: "run", aggregateId: "r1", aggregateVersion: 2, data: '{"n":2}' })
    expect(e2.aggregateVersion).toBe(2)
    expect(repo.getMaxAggregateVersion("run", "r1")).toBe(2)
  })

  it("rejects duplicate aggregate version", () => {
    const { db } = initializeDatabase({ path: TEST_DB })
    const tx = createTransactionManager(db)
    const { EventsRepository } = require("../repositories/event")
    const repo = new EventsRepository(db, tx)
    repo.append({ eventId: "e3", eventType: "Test", aggregateType: "run", aggregateId: "r2", aggregateVersion: 1, data: "{}" })
    expect(() => repo.append({ eventId: "e4", eventType: "Test", aggregateType: "run", aggregateId: "r2", aggregateVersion: 1, data: "{}" })).toThrow()
  })

  it("stores outbox records", () => {
    const { db } = initializeDatabase({ path: TEST_DB })
    const tx = createTransactionManager(db)
    const { EventsRepository } = require("../repositories/event")
    const repo = new EventsRepository(db, tx)
    repo.append({ eventId: "e5", eventType: "OutboxTest", aggregateType: "run", aggregateId: "r3", aggregateVersion: 1, data: "{}" })
    const ob = repo.insertOutbox({ id: "ob1", eventId: "e5", eventType: "OutboxTest", aggregateId: "r3", data: "{}", idempotencyKey: "ik1", sourceComponent: "test" })
    expect(ob.status).toBe("pending")
  })
})

describe("Repository: TaskRuns", () => {
  beforeEach(clean)
  afterEach(clean)

  it("creates and updates task runs", () => {
    const { db } = initializeDatabase({ path: TEST_DB })
    const tx = createTransactionManager(db)
    db.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES ('fam', 't', 't', datetime('now'))").run()
    db.prepare(`INSERT INTO task_contracts (contract_id, family_id, version, title, description, repo_url, repo_sha, created_by, created_at)
      VALUES ('ctr', 'fam', 1, 'T', 'D', 'u', 's', 't', datetime('now'))`).run()

    const { TaskRunsRepository } = require("../repositories/task-run")
    const repo = new TaskRunsRepository(db, tx)
    const run = repo.create({ runId: "run1", contractId: "ctr", strategy: "simple", baselineSha: "abc", repoBranch: "main" })
    expect(run.state).toBe("created")
    expect(run.aggregateVersion).toBe(1)

    repo.updateState("run1", "executing")
    expect(repo.findById("run1")!.state).toBe("executing")
  })
})
