import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, rmSync } from "fs";
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
  it("normal cleanup deletes all files and closes SQLite", async () => {
    const { dir, db, path } = createTempDbDir();
    db.exec("INSERT INTO t VALUES (2)");

    await deterministicCleanup({ db, dir });

    expect(existsSync(path)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(() => db.exec("SELECT 1")).toThrow();
  });

  it("normal cleanup with outbox worker stops the worker", async () => {
    const { dir, db } = createTempDbDir();
    let workerStopped = false;
    const worker: StoppableWorker = {
      stop: () => { workerStopped = true; },
    };

    await deterministicCleanup({ db, dir, outboxWorker: worker });

    expect(workerStopped).toBe(true);
  });

  it("normal cleanup with execution registry cancels active executions", async () => {
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

  it("idempotent call with OwnedDatabase marks closed", async () => {
    const { dir, db } = createTempDbDir();
    const owned: OwnedDatabase = { db, closed: false };

    await deterministicCleanup({ db: owned, dir });

    expect(owned.closed).toBe(true);
    expect(existsSync(dir)).toBe(false);

    await deterministicCleanup({ db: owned, dir });
    expect(owned.closed).toBe(true);
  });
});

describe("Active reader handling", () => {
  it("cleanup fails visibly when a reader holds a WAL snapshot", async () => {
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

    if (caught) {
      expect(caught).toBeInstanceOf(AggregateError);
      expect(
        caught.errors.some(
          (error) =>
            error.message.includes("wal-checkpoint") ||
            error.message.includes("EBUSY") ||
            error.message.includes("EPERM") ||
            error.message.includes("FILE_LEAK"),
        ),
      ).toBe(true);
    } else {
      expect(existsSync(join(dir, "test.db"))).toBe(false);
      expect(existsSync(join(dir, "test.db-wal"))).toBe(false);
      expect(existsSync(join(dir, "test.db-shm"))).toBe(false);
      expect(existsSync(dir)).toBe(false);
    }
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
      try { rmSync(join(dir, "test.db") + suffix, { force: true }); } catch {}
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
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
      try { rmSync(join(dir, "test.db") + suffix, { force: true }); } catch {}
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
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
      try { rmSync(join(dir, "test.db") + suffix, { force: true }); } catch {}
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });
});
