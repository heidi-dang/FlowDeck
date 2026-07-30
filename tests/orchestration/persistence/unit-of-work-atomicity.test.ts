import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SqliteUnitOfWork } from "../../../src/orchestration/persistence/unit-of-work";
import { deterministicCleanup } from "../harness/cleanup";

describe("SqliteUnitOfWork Atomicity", () => {
  let tempDir: string;
  let db: Database;
  let unitOfWork: SqliteUnitOfWork;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "uow-test-"));
    db = new Database(join(tempDir, "test.db"));
    db.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT);
    `);
    unitOfWork = new SqliteUnitOfWork(db);
  });

  afterEach(() => {
    deterministicCleanup({ db, dir: tempDir });
  });

  it("commits multiple operations atomically on success", async () => {
    await unitOfWork.execute((_ctx) => {
      db.prepare("INSERT INTO runs (id, status) VALUES (?, ?)").run("r1", "running");
      db.prepare("INSERT INTO events (id, type) VALUES (?, ?)").run("e1", "run.started");
    });

    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get("r1") as any;
    const event = db.prepare("SELECT * FROM events WHERE id = ?").get("e1") as any;

    expect(run?.status).toBe("running");
    expect(event?.type).toBe("run.started");
  });

  it("rolls back all operations if any statement throws an error", async () => {
    try {
      await unitOfWork.execute((_ctx) => {
        db.prepare("INSERT INTO runs (id, status) VALUES (?, ?)").run("r2", "queued");
        db.prepare("INSERT INTO events (id, type) VALUES (?, ?)").run("e2", "run.queued");
        throw new Error("Simulated outbox/event failure");
      });
    } catch (err: any) {
      expect(err.message).toBe("Simulated outbox/event failure");
    }

    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get("r2");
    const event = db.prepare("SELECT * FROM events WHERE id = ?").get("e2");

    expect(run).toBeNull();
    expect(event).toBeNull();
  });
});
