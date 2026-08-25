import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { rm } from "node:fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { deterministicCleanup } from "./harness/cleanup";
import type { OwnedDatabase, StoppableWorker } from "./harness/cleanup";
import { ExecutionRegistry } from "../../src/orchestration/services/execution-registry";

function createTempDbDir(): { dir: string; db: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "res-clean-"));
  const path = join(dir, "test.db");
  const db = new Database(path);
  db.exec("CREATE TABLE t (x INTEGER)");
  db.exec("INSERT INTO t VALUES (1)");
  db.exec("PRAGMA journal_mode=WAL");
  return { dir, db, path };
}

function walExists(dir: string): boolean {
  return existsSync(join(dir, "test.db-wal")) || existsSync(join(dir, "test.db-shm"));
}

function dbExists(dir: string): boolean {
  return existsSync(join(dir, "test.db"));
}

describe("Cleanup lifecycle", () => {
  it("normal cleanup strict-closes SQLite and deletes all files", async () => {
    const { dir, db, path } = createTempDbDir();
    db.exec("INSERT INTO t VALUES (2)");

    await deterministicCleanup({ db, dir });

    expect(existsSync(path)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(() => db.exec("SELECT 1")).toThrow();
  });

  it("cleanup with outbox worker stops the worker", async () => {
    const { dir, db } = createTempDbDir();
    let workerStopped = false;
    const worker: StoppableWorker = {
      stop: () => { workerStopped = true; },
    };

    await deterministicCleanup({ db, dir, outboxWorker: worker });

    expect(workerStopped).toBe(true);
  });

  it("cleanup with execution registry cancels active executions", async () => {
    const { dir, db } = createTempDbDir();
    const registry = new ExecutionRegistry();
    const handle = registry.registerRun("run-1");
    handle.executionPromise = Promise.resolve();

    await deterministicCleanup({ db, dir, executionRegistry: registry as any });

    expect(registry.getActiveRunIds()).toEqual([]);
  });

  it("idempotent second call succeeds without errors", async () => {
    const { dir, db } = createTempDbDir();

    await deterministicCleanup({ db, dir });
    await deterministicCleanup({ dir });
    await deterministicCleanup({ dir });

    expect(existsSync(dir)).toBe(false);
  });

  it("idempotent call with OwnedDatabase marks closed exactly once", async () => {
    const { dir, db } = createTempDbDir();
    const owned: OwnedDatabase = { db, closed: false };

    await deterministicCleanup({ db: owned, dir });

    expect(owned.closed).toBe(true);
    expect(existsSync(dir)).toBe(false);

    await deterministicCleanup({ db: owned, dir });
    expect(owned.closed).toBe(true);
  });

  it("ownership guard: an owned primary already closed and marked is never re-closed", async () => {
    // Reconnect scenario: the fixture closes its own connection and records
    // the ownership transfer (closed=true) before handing the context back to
    // cleanup. The ownership guard must skip WAL shutdown + strict close on
    // the already-closed primary (both would throw on a closed handle) while
    // still completing the remaining work — file removal — without errors.
    const { dir, db } = createTempDbDir();
    const owned: OwnedDatabase = { db, closed: false };
    db.close();
    owned.closed = true;

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({ db: owned, dir });
    } catch (e) {
      caught = e instanceof AggregateError ? e : null;
    }

    expect(caught).toBeNull();
    expect(owned.closed).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("partial setup: empty context and dir-only context are no-ops", async () => {
    await deterministicCleanup({});
    await deterministicCleanup({ dir: undefined });
  });
});

describe("Strict closure", () => {
  it("strict close succeeds on a clean connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "res-clean-"));
    const db = new Database(join(dir, "test.db"));
    db.exec("CREATE TABLE t (x INTEGER)");

    await deterministicCleanup({ db, dir });

    expect(existsSync(dir)).toBe(false);
  });

  it("safely closes a held prepared statement when Bun accepts close(true)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "res-clean-"));
    const db = new Database(join(dir, "test.db"));
    db.exec("CREATE TABLE t (x INTEGER)");
    const pending = db.prepare("SELECT * FROM t");

    await deterministicCleanup({ db, dir });

    expect(() => pending.all()).toThrow();
    expect(() => db.query("SELECT 1").get()).toThrow();
    expect(existsSync(dir)).toBe(false);
  });

  it("surfaces a deterministic primary strict-close failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "res-clean-"));
    const db = new Database(join(dir, "test.db"));
    db.exec("CREATE TABLE t (x INTEGER)");

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({
        db,
        dir,
        hooks: { closeDatabase: () => { throw new Error("injected close failure"); } },
      });
    } catch (error) {
      caught = error instanceof AggregateError ? error : null;
    }

    expect(caught).not.toBeNull();
    expect(caught!.errors.some((error) => error.message.includes("sqlite-strict-close-primary"))).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("extra connections are strict-closed before file removal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "res-clean-"));
    const path = join(dir, "test.db");
    const db = new Database(path);
    db.exec("CREATE TABLE t (x INTEGER)");
    const secondary = new Database(path);
    secondary.query("SELECT 1").get();

    await deterministicCleanup({ db, dir, extraConnections: [secondary] });

    expect(existsSync(dir)).toBe(false);
    expect(() => secondary.query("SELECT 1").get()).toThrow();
  });

  it("surfaces a deterministic extra-connection strict-close failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "res-clean-"));
    const path = join(dir, "test.db");
    const db = new Database(path);
    db.exec("CREATE TABLE t (x INTEGER)");
    const secondary = new Database(path);

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({
        db,
        dir,
        extraConnections: [secondary],
        hooks: {
          closeDatabase: (connection, throwOnError) => {
            if (connection === secondary) throw new Error("injected close failure");
            connection.close(throwOnError);
          },
        },
      });
    } catch (error) {
      caught = error instanceof AggregateError ? error : null;
    }

    expect(caught).not.toBeNull();
    expect(caught!.errors.some((error) => error.message.includes("sqlite-strict-close-extra-0"))).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("Active reader handling", () => {
  it("reader holding a WAL snapshot fails cleanup visibly; rollback+close then succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "res-clean-"));
    const path = join(dir, "test.db");
    const db = new Database(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE t (x INTEGER)");
    db.exec("INSERT INTO t VALUES (1)");

    const reader = new Database(path);
    reader.exec("BEGIN");
    reader.query("SELECT * FROM t").all();
    // Create a WAL frame after the reader has established its snapshot.
    db.exec("INSERT INTO t VALUES (2)");

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({ db, dir });
    } catch (e) {
      caught = e instanceof AggregateError ? e : null;
    }

    // Failure phase: the checkpoint must observe the active reader.
    expect(caught).not.toBeNull();
    expect(
      caught!.errors.some((error) => error.message.includes("wal-checkpoint")),
    ).toBe(true);

    // Post-close success phase: rollback + strict close the reader, then a
    // fresh WAL connection shuts down cleanly and cleanup succeeds (the
    // primary was already closed by the failure phase above).
    reader.exec("ROLLBACK");
    reader.close(true);
    // On Windows the failure-phase rm cannot remove a dir whose -shm/-wal
    // files are held by the open reader, so the dir survives. Clear any
    // leftovers deterministically before recreating it.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const fresh = new Database(path);
    fresh.exec("PRAGMA journal_mode=WAL");
    fresh.exec("CREATE TABLE t (x INTEGER)");
    await deterministicCleanup({ db: fresh, dir });

    expect(existsSync(join(dir, "test.db"))).toBe(false);
    expect(existsSync(join(dir, "test.db-wal"))).toBe(false);
    expect(existsSync(join(dir, "test.db-shm"))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("Extra connection WAL coexistence", () => {
  it("an extra WAL connection holding a read+write lock is closed before the primary checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "res-clean-"));
    const path = join(dir, "test.db");
    const db = new Database(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE t (x INTEGER)");
    db.exec("INSERT INTO t VALUES (1)");

    // The extra connection performs a read and a write inside an open
    // transaction, so it holds both a WAL read snapshot (which blocks a
    // TRUNCATE checkpoint) and an uncommitted write. Only closing it releases
    // the snapshot; the primary must not attempt its checkpoint first.
    const extra = new Database(path);
    extra.exec("BEGIN");
    extra.query("SELECT * FROM t").all();
    extra.exec("INSERT INTO t VALUES (2)");

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({ db, dir, extraConnections: [extra] });
    } catch (e) {
      caught = e instanceof AggregateError ? e : null;
    }

    expect(caught).toBeNull();
    // Both connections are closed after cleanup.
    expect(() => db.exec("SELECT 1")).toThrow();
    expect(() => extra.exec("SELECT 1")).toThrow();
    // All SQLite files (db, -wal, -shm) and the directory are removed.
    expect(existsSync(join(dir, "test.db"))).toBe(false);
    expect(existsSync(join(dir, "test.db-wal"))).toBe(false);
    expect(existsSync(join(dir, "test.db-shm"))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("Worker still using database", () => {
  it("cleanup awaits worker shutdown before closing SQLite", async () => {
    const { dir, db } = createTempDbDir();
    let workerDone = false;
    const worker: StoppableWorker = {
      stop: async () => {
        await new Promise((r) => setTimeout(r, 10));
        workerDone = true;
      },
    };

    await deterministicCleanup({ db, dir, outboxWorker: worker });

    expect(workerDone).toBe(true);
  });

  it("worker stop failure does not block cleanup completion", async () => {
    const { dir, db } = createTempDbDir();
    const worker: StoppableWorker = {
      stop: () => { throw new Error("worker-crash"); },
    };

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({ db, dir, outboxWorker: worker });
    } catch (e) {
      caught = e instanceof AggregateError ? e : null;
    }

    expect(caught).not.toBeNull();
    const workerErrors = caught!.errors.filter((e) => e.message.includes("worker-stop"));
    expect(workerErrors.length).toBeGreaterThanOrEqual(1);
    // Even though worker stop failed, files should still be cleaned
    expect(existsSync(dir)).toBe(false);
  });
});

describe("Execution cancellation", () => {
  it("cleanup cancels and awaits active execution", async () => {
    const { dir, db } = createTempDbDir();
    const registry = new ExecutionRegistry();
    const handle = registry.registerRun("exec-1");
    handle.executionPromise = new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    handle.resolveExecution = () => {};

    await deterministicCleanup({ db, dir, executionRegistry: registry as any });

    expect(registry.getActiveRunIds()).toEqual([]);
  });

  it("execution timeout is recorded and cleanup still completes", async () => {
    const { dir, db } = createTempDbDir();
    const registry = new ExecutionRegistry();
    registry.registerRun("slow-exec");
    const handle = registry.getHandle("slow-exec")!;
    handle.executionPromise = new Promise<void>(() => {});

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({ db, dir, executionRegistry: registry as any, executionTimeoutMs: 500 });
    } catch (e) {
      caught = e instanceof AggregateError ? e : null;
    }

    // The execution should time out because the promise never resolves
    expect(caught).not.toBeNull();
    const timeoutMsgs = caught!.errors.filter((e) => e.message.includes("timed out"));
    expect(timeoutMsgs.length).toBeGreaterThanOrEqual(1);
    // Files should still be cleaned up despite the timeout
    expect(existsSync(dir)).toBe(false);
  });

  it("execution timeout retains the run id in the recorded error", async () => {
    const { dir, db } = createTempDbDir();
    const registry = new ExecutionRegistry();
    const runId = "timeout-id-retained";
    registry.registerRun(runId);
    const handle = registry.getHandle(runId)!;
    handle.executionPromise = new Promise<void>(() => {});

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({ db, dir, executionRegistry: registry as any, executionTimeoutMs: 300 });
    } catch (e) {
      caught = e instanceof AggregateError ? e : null;
    }

    expect(caught).not.toBeNull();
    expect(
      caught!.errors.some((e) => e.message.includes("timed out") && e.message.includes(runId)),
    ).toBe(true);
  });

  it("bad run id: cancelling an unknown run is a no-op, never a cleanup failure", async () => {
    const { dir, db } = createTempDbDir();
    const registry = new ExecutionRegistry();

    // A run id that was never registered must resolve as a benign no-op
    // (cancelled: false) instead of throwing or reporting a cleanup error.
    const result = await registry.cancelRunExecution("never-registered", "runtime_cleanup");
    expect(result).toEqual({ cancelled: false, cleanupErrors: [], timedOut: false });
    expect(registry.getActiveRunIds()).toEqual([]);

    // Cleanup with a registry that holds no active runs (and therefore cannot
    // be asked to cancel anything) completes without any diagnostic errors.
    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({ db, dir, executionRegistry: registry as any });
    } catch (e) {
      caught = e instanceof AggregateError ? e : null;
    }

    expect(caught).toBeNull();
    expect(registry.getActiveRunIds()).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("Registry guard", () => {
  it("throws when execution handles remain after cancel", async () => {
    const { dir, db } = createTempDbDir();
    const registry = new ExecutionRegistry();

    const handle = registry.registerRun("stuck-run");
    handle.executionPromise = new Promise<void>(() => {});
    // also register a second handle that can be cancelled
    const handle2 = registry.registerRun("ok-run");
    handle2.executionPromise = Promise.resolve();

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({
        db, dir,
        executionRegistry: registry as any,
        executionTimeoutMs: 500,
      });
    } catch (e) {
      caught = e instanceof AggregateError ? e : null;
    }

    expect(caught).not.toBeNull();
    const leakMsgs = caught!.errors.filter((e) => e.message.includes("execution-leak"));
    expect(leakMsgs.length).toBeGreaterThanOrEqual(1);

    for (const suffix of ["", "-wal", "-shm"]) {
      try { await import("node:fs/promises").then(({ rm }) => rm(join(dir, "test.db") + suffix, { force: true })); } catch {}
    }
    try { await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true })); } catch {}
  });
});

describe("Retry independence and error retention", () => {
  it("a blocked target fails with full diagnostics without starving other targets", async () => {
    // Make the primary db "file" a non-empty directory. Non-recursive rm of a
    // directory deterministically fails, but the enclosing temp dir must still
    // be removed by its own bounded retry budget.
    const dir = mkdtempSync(join(tmpdir(), "res-clean-"));
    const dbPath = join(dir, "test.db");
    mkdirSync(dbPath);
    writeFileSync(join(dbPath, "inner.txt"), "x");
    const db = new Database(join(dir, "other.db"));
    db.exec("CREATE TABLE t (x INTEGER)");

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({ db, dir });
    } catch (e) {
      caught = e instanceof AggregateError ? e : null;
    }

    expect(caught).not.toBeNull();
    const removal = caught!.errors.find((e) => e.message.includes("[file-remove]"));
    expect(removal).toBeDefined();
    expect(removal!.message).toContain(`target=${dbPath}`);
    expect(removal!.message).toMatch(/code=/);
    expect(removal!.message).toMatch(/errno=/);
    expect(removal!.message).toMatch(/syscall=/);
    expect(removal!.message).toMatch(/elapsed=/);
    // Independent per-target retry: the enclosing dir is still removed.
    expect(existsSync(dir)).toBe(false);
  });

  it("leak errors are supplemented with removal details, not replaced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "res-clean-"));
    const dbPath = join(dir, "test.db");
    mkdirSync(dbPath);
    writeFileSync(join(dbPath, "inner.txt"), "x");
    const db = new Database(join(dir, "other.db"));
    db.exec("CREATE TABLE t (x INTEGER)");

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({ db, dir });
    } catch (e) {
      caught = e instanceof AggregateError ? e : null;
    }

    expect(caught).not.toBeNull();
    expect(
      caught!.errors.some((e) => e.message.includes("[file-remove]")),
    ).toBe(true);
  });

  it("recursive directory removal leaves no trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "res-clean-"));
    const nested = join(dir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "file.txt"), "x");
    const db = new Database(join(dir, "test.db"));
    db.exec("CREATE TABLE t (x INTEGER)");

    await deterministicCleanup({ db, dir });

    expect(existsSync(dir)).toBe(false);
  });
});

describe("AggregateError reporting", () => {
  it("single failure produces AggregateError with 1 error", async () => {
    const { dir, db } = createTempDbDir();
    const badWorker: StoppableWorker = {
      stop: () => { throw new Error("worker-crash"); },
    };

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({ db, dir, outboxWorker: badWorker });
    } catch (e) {
      caught = e instanceof AggregateError ? e : null;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toBe("ORCHESTRATION_CLEANUP_FAILED");
    expect(caught!.errors.length).toBe(1);

    for (const suffix of ["", "-wal", "-shm"]) {
      try { await import("node:fs/promises").then(({ rm }) => rm(join(dir, "test.db") + suffix, { force: true })); } catch {}
    }
    try { await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true })); } catch {}
  });

  it("multiple failures produce AggregateError with >=2 errors", async () => {
    const { dir, db } = createTempDbDir();
    const registry = new ExecutionRegistry();
    registry.registerRun("never-ends");
    const handle = registry.getHandle("never-ends")!;
    handle.executionPromise = new Promise<void>(() => {});

    // After execution timeout, we also trigger worker failure for multi-failure
    const badWorker: StoppableWorker = {
      stop: () => { throw new Error("worker-exploded"); },
    };

    let caught: AggregateError | null = null;
    try {
      await deterministicCleanup({
        db,
        dir,
        outboxWorker: badWorker,
        executionRegistry: registry as any,
        executionTimeoutMs: 500,
      });
    } catch (e) {
      caught = e instanceof AggregateError ? e : null;
    }

    expect(caught).not.toBeNull();
    expect(caught!.errors.length).toBeGreaterThanOrEqual(2);
    expect(caught!.message).toBe("ORCHESTRATION_CLEANUP_FAILED");

    for (const suffix of ["", "-wal", "-shm"]) {
      try { await import("node:fs/promises").then(({ rm }) => rm(join(dir, "test.db") + suffix, { force: true })); } catch {}
    }
    try { await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true })); } catch {}
  });
});

describe("Handle-leak verification", () => {
  it("no active handles or files remain after cleanup", async () => {
    const { dir, db } = createTempDbDir();
    const registry = new ExecutionRegistry();
    const worker: StoppableWorker = { stop: () => {} };

    registry.registerRun("h-1");
    const handle = registry.getHandle("h-1")!;
    handle.executionPromise = Promise.resolve();

    await deterministicCleanup({
      db, dir,
      outboxWorker: worker,
      executionRegistry: registry as any,
    });

    expect(registry.getActiveRunIds()).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(dbExists(dir)).toBe(false);
    expect(walExists(dir)).toBe(false);
  });
});

describe("Path handling", () => {
  it("cleanup works with a temp dir containing spaces", async () => {
    const base = mkdtempSync(join(tmpdir(), "res-clean-"));
    const dir = join(base, "spaced dir");
    mkdirSync(dir);
    const db = new Database(join(dir, "test.db"));
    db.exec("CREATE TABLE t (x INTEGER)");

    await deterministicCleanup({ db, dir });

    expect(existsSync(dir)).toBe(false);
    await rm(base, { recursive: true, force: true });
  });

  it("cleanup with a custom db file name removes all sidecar files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "res-clean-"));
    const db = new Database(join(dir, "custom.sqlite"));
    db.exec("CREATE TABLE t (x INTEGER)");
    db.exec("PRAGMA journal_mode=WAL");

    await deterministicCleanup({ db, dir, dbFileName: "custom.sqlite" });

    expect(existsSync(join(dir, "custom.sqlite"))).toBe(false);
    expect(existsSync(join(dir, "custom.sqlite-wal"))).toBe(false);
    expect(existsSync(join(dir, "custom.sqlite-shm"))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });
});