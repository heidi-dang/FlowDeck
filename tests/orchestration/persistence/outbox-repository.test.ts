import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { createTransactionManager } from "@/orchestration/persistence/transaction-manager";
import { SqliteOutboxRepository } from "@/orchestration/persistence/adapters/sqlite-outbox-repository";
import { OutboxStatus as OS } from "@/orchestration/types/outbox";
import type { OutboxEntry } from "@/orchestration/types/outbox";

// ── Helpers ────────────────────────────────────────────────────────────

let tmpDir = "";

function clean(): void {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    tmpDir = "";
  }
}

function setupDb(): Database {
  clean();
  tmpDir = mkdtempSync(join(tmpdir(), "fd-outbox-"));
  const db = new Database(join(tmpDir, "test.db"), { create: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_outbox (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_retry_ts INTEGER,
      created_ts INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      source_component TEXT NOT NULL
    )
  `);
  return db;
}

function makeEntry(id: string): OutboxEntry {
  return {
    id,
    eventId: `evt-${id}`,
    eventType: "TestEvent",
    status: OS.PENDING,
    correlationId: `corr-${id}`,
    aggregateId: `agg-${id}`,
    attemptCount: 0,
    maxRetries: 3,
    payload: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Insert a row with an arbitrary status directly (bypassing repo.create's hardcoded 'pending'). */
function insertRaw(
  db: Database,
  id: string,
  status: string,
  extra?: { lastError?: string },
): void {
  db.prepare(
    "INSERT INTO event_outbox (id, event_id, event_type, aggregate_id, data, status, retry_count, idempotency_key, source_component, created_ts) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, strftime('%s','now'))",
  ).run(id, `evt-${id}`, "Test", `agg-${id}`, "{}", status, `corr-${id}`, "test");
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("SqliteOutboxRepository", () => {
  let db: Database;
  let repo: SqliteOutboxRepository;

  beforeEach(() => {
    db = setupDb();
    const tx = createTransactionManager(db);
    repo = new SqliteOutboxRepository(db, tx);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
    clean();
  });

  describe("create", () => {
    it("persists an outbox entry to SQLite", async () => {
      const entry = makeEntry("ob-1");
      const result = await repo.create(entry);

      expect(result).toBeDefined();
      expect(result.id).toBe("ob-1");
      expect(result.eventId).toBe("evt-ob-1");
      expect(result.eventType).toBe("TestEvent");
      expect(result.status).toBe(OS.PENDING);
      expect(result.aggregateId).toBe("agg-ob-1");

      // Verify directly in SQLite
      const row = db.prepare("SELECT * FROM event_outbox WHERE id = ?").get("ob-1") as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.id).toBe("ob-1");
      expect(row.event_id).toBe("evt-ob-1");
      expect(row.status).toBe("pending");
      expect(row.idempotency_key).toBe("corr-ob-1");
    });

    it("assigns created_ts automatically", async () => {
      const entry = makeEntry("ob-ts");
      await repo.create(entry);

      const row = db.prepare("SELECT created_ts FROM event_outbox WHERE id = ?").get("ob-ts") as Record<string, unknown>;
      expect(row.created_ts).toBeGreaterThan(0);
    });
  });

  describe("findPending", () => {
    it("returns only pending entries", async () => {
      await repo.create(makeEntry("ob-p1"));
      await repo.create(makeEntry("ob-p2"));
      insertRaw(db, "ob-d1", "delivered");
      insertRaw(db, "ob-f1", "failed");

      const pending = await repo.findPending();

      expect(pending).toHaveLength(2);
      expect(pending.every((e) => e.status === OS.PENDING)).toBe(true);
    });

    it("returns empty array when no pending entries exist", async () => {
      insertRaw(db, "ob-d1", "delivered");

      const pending = await repo.findPending();

      expect(pending).toEqual([]);
    });

    it("limits results to 100 entries", async () => {
      for (let i = 0; i < 120; i++) {
        await repo.create(makeEntry(`ob-mass-${i}`));
      }

      const pending = await repo.findPending();
      expect(pending.length).toBeLessThanOrEqual(100);
    });
  });

  describe("update", () => {
    it("updates status to DELIVERED", async () => {
      await repo.create(makeEntry("ob-upd1"));

      const updated = await repo.update("ob-upd1", { status: OS.DELIVERED });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe(OS.DELIVERED);

      const row = db.prepare("SELECT status FROM event_outbox WHERE id = ?").get("ob-upd1") as Record<string, unknown>;
      expect(row.status).toBe("delivered");
    });

    it("updates status to FAILED", async () => {
      await repo.create(makeEntry("ob-upd2"));

      const updated = await repo.update("ob-upd2", { status: OS.FAILED, lastError: "Connection refused" });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe(OS.FAILED);
      expect(updated!.lastError).toBe("Connection refused");

      const row = db.prepare("SELECT status, last_error FROM event_outbox WHERE id = ?").get("ob-upd2") as Record<string, unknown>;
      expect(row.status).toBe("failed");
      expect(row.last_error).toBe("Connection refused");
    });

    it("returns null for non-existent id", async () => {
      const result = await repo.update("no-such-id", { status: OS.DELIVERED });
      expect(result).toBeNull();
    });

    it("updates retry_count when setting attemptCount", async () => {
      await repo.create(makeEntry("ob-retry"));
      const updated = await repo.update("ob-retry", { attemptCount: 2 });

      expect(updated!.attemptCount).toBe(2);

      const row = db.prepare("SELECT retry_count FROM event_outbox WHERE id = ?").get("ob-retry") as Record<string, unknown>;
      expect(row.retry_count).toBe(2);
    });
  });

  describe("findMany", () => {
    it("returns all entries with no filter", async () => {
      await repo.create(makeEntry("ob-fm1"));
      insertRaw(db, "ob-fm2", "delivered");
      insertRaw(db, "ob-fm3", "failed");

      const result = await repo.findMany({}, { page: 1, limit: 20 });

      expect(result.items).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it("filters by status", async () => {
      await repo.create(makeEntry("ob-f1"));
      insertRaw(db, "ob-f2", "delivered");

      const result = await repo.findMany({ status: OS.DELIVERED }, { page: 1, limit: 20 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("ob-f2");
      expect(result.total).toBe(1);
    });

    it("supports pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await repo.create(makeEntry(`ob-page-${i}`));
      }

      const page1 = await repo.findMany({}, { page: 1, limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page1.page).toBe(1);

      const page2 = await repo.findMany({}, { page: 2, limit: 2 });
      expect(page2.items).toHaveLength(2);
      expect(page2.total).toBe(5);
      expect(page2.page).toBe(2);
    });
  });

  describe("count", () => {
    it("returns total count with no filter", async () => {
      await repo.create(makeEntry("ob-c1"));
      insertRaw(db, "ob-c2", "delivered");
      insertRaw(db, "ob-c3", "failed");

      const total = await repo.count({});
      expect(total).toBe(3);
    });

    it("counts by status filter", async () => {
      await repo.create(makeEntry("ob-ct1"));
      insertRaw(db, "ob-ct2", "delivered");
      await repo.create(makeEntry("ob-ct3"));

      const pendingCount = await repo.count({ status: OS.PENDING });
      expect(pendingCount).toBe(2);

      const deliveredCount = await repo.count({ status: OS.DELIVERED });
      expect(deliveredCount).toBe(1);

      const failedCount = await repo.count({ status: OS.FAILED });
      expect(failedCount).toBe(0);
    });
  });

  describe("transaction rollback", () => {
    it("rolls back insert on failure inside transaction", async () => {
      const tx = createTransactionManager(db);
      try {
        await tx.write(() => {
          db.prepare(
            "INSERT INTO event_outbox (id, event_id, event_type, aggregate_id, data, status, retry_count, idempotency_key, source_component, created_ts) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, strftime('%s','now'))",
          ).run("ob-rollback", "evt-roll", "Test", "agg-r", "{}", "corr-roll", "test");
          throw new Error("simulated failure");
        });
      } catch {
        // expected
      }

      const row = db.prepare("SELECT COUNT(*) AS c FROM event_outbox WHERE id = 'ob-rollback'").get() as { c: number };
      expect(row.c).toBe(0);
    });

    it("rolls back update on failure inside transaction", async () => {
      await repo.create(makeEntry("ob-roll-upd"));

      const tx = createTransactionManager(db);
      try {
        await tx.write(() => {
          db.prepare("UPDATE event_outbox SET status = ? WHERE id = ?").run("delivered", "ob-roll-upd");
          throw new Error("simulated update failure");
        });
      } catch {
        // expected
      }

      const row = db.prepare("SELECT status FROM event_outbox WHERE id = 'ob-roll-upd'").get() as Record<string, unknown>;
      expect(row.status).toBe("pending");
    });

    it("independent transactions are not affected by each other's failures", async () => {
      // This create succeeds in its own implicit transaction
      await repo.create(makeEntry("ob-tx-safe"));

      // Another transaction that includes a create + deliberate failure
      const tx = createTransactionManager(db);
      try {
        await tx.write(() => {
          db.prepare(
            "INSERT INTO event_outbox (id, event_id, event_type, aggregate_id, data, status, retry_count, idempotency_key, source_component, created_ts) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, strftime('%s','now'))",
          ).run("ob-tx-fail", "evt-fail", "Test", "agg-f", "{}", "corr-fail", "test");
          throw new Error("outer tx failure");
        });
      } catch {
        // expected
      }

      // ob-tx-safe was created in its own transaction and should exist
      const safe = db.prepare("SELECT COUNT(*) AS c FROM event_outbox WHERE id = 'ob-tx-safe'").get() as { c: number };
      expect(safe.c).toBe(1);

      // ob-tx-fail was inside the failed transaction and should not exist
      const fail = db.prepare("SELECT COUNT(*) AS c FROM event_outbox WHERE id = 'ob-tx-fail'").get() as { c: number };
      expect(fail.c).toBe(0);
    });
  });
});