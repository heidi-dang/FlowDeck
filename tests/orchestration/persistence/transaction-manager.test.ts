import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Database } from "bun:sqlite"
import { createTransactionManager } from "@/orchestration/persistence/transaction-manager"
import { createDefaultPolicy } from "@/orchestration/persistence/retry-policy"
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

function setupTestDb(): Database {
  currentDir = mkdtempSync(join(tmpdir(), "fd-txn-mgr-"))
  TEST_DB = join(currentDir, "test.db")
  const db = new Database(TEST_DB, { create: true })
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA journal_mode = WAL")
  db.exec("CREATE TABLE IF NOT EXISTS contract_families (family_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL)")
  return db
}

describe("TransactionManager", () => {
  beforeEach(clean)
  afterEach(clean)

  describe("sync/async guards", () => {
    it("sync write commits", () => {
      const db = setupTestDb()
      const tx = createTransactionManager(db)
      tx.write(() => {
        db.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES (?, 'test', 'test', datetime('now'))").run("fam-1")
      })
      const count = (db.prepare("SELECT COUNT(*) AS c FROM contract_families").get() as { c: number }).c
      expect(count).toBe(1)
      db.close()
    })

    it("sync read executes without transaction overhead", () => {
      const db = setupTestDb()
      const tx = createTransactionManager(db)
      const res = tx.read(() => {
        return db.prepare("SELECT 42 AS val").get() as { val: number }
      })
      expect(res.val).toBe(42)
      db.close()
    })

    it("throw rolls back the transaction", () => {
      const db = setupTestDb()
      const tx = createTransactionManager(db)
      expect(() => {
        tx.write(() => {
          db.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES (?, 'test', 'test', datetime('now'))").run("fam-1")
          throw new Error("force_rollback")
        })
      }).toThrow("force_rollback")
      const count = (db.prepare("SELECT COUNT(*) AS c FROM contract_families").get() as { c: number }).c
      expect(count).toBe(0)
      db.close()
    })

    it("rejects async callbacks (thenable detection)", () => {
      const db = setupTestDb()
      const tx = createTransactionManager(db)
      expect(() => {
        tx.write(() => Promise.resolve("async") as any)
      }).toThrow(/Promise|synchronous/i)
      db.close()
    })

    it("rejects async callbacks in read", () => {
      const db = setupTestDb()
      const tx = createTransactionManager(db)
      expect(() => {
        tx.read(() => Promise.resolve("async") as any)
      }).toThrow(/Promise|synchronous/i)
      db.close()
    })

    it("rejects async callbacks in savepoint", () => {
      const db = setupTestDb()
      const tx = createTransactionManager(db)
      expect(() => {
        tx.write(() => {
          tx.savepoint("sp1", () => Promise.resolve("async") as any)
        })
      }).toThrow(/Promise|synchronous/i)
      db.close()
    })
  })

  describe("savepoints", () => {
    it("inner savepoint rolls back while outer commits", () => {
      const db = setupTestDb()
      const tx = createTransactionManager(db)
      tx.write(() => {
        db.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES (?, 'outer', 'test', datetime('now'))").run("fam-outer")
        expect(() => {
          tx.savepoint("sp_inner", () => {
            db.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES (?, 'inner', 'test', datetime('now'))").run("fam-inner")
            throw new Error("rollback_inner")
          })
        }).toThrow("rollback_inner")
      })
      const rows = db.prepare("SELECT family_id FROM contract_families").all() as { family_id: string }[]
      expect(rows.map(r => r.family_id)).toEqual(["fam-outer"])
      db.close()
    })
  })

  describe("retry policy", () => {
    it("classifies UNIQUE constraint as non-retryable", () => {
      const policy = createDefaultPolicy()
      const err = new Error("UNIQUE constraint failed: contract_families.family_id")
      expect(policy.isRetryable(policy.classify(err))).toBe(false)
    })

    it("classifies BUSY as retryable", () => {
      const policy = createDefaultPolicy()
      const err = new Error("database is locked (busy)")
      expect(policy.isRetryable(policy.classify(err))).toBe(true)
    })
  })
})
