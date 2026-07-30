import { Database } from "bun:sqlite";
import { rmSync, existsSync } from "fs";
import { join } from "path";

export interface StoppableWorker {
  stop(): void | Promise<void>;
}

export interface OwnedDatabase {
  db: Database;
  closed: boolean;
}

export interface ExecutionRegistryHandle {
  cancelRunExecution(runId: string, reason?: string, timeoutMs?: number): Promise<{
    cancelled: boolean;
    cleanupErrors: Error[];
    timedOut: boolean;
  }>;
  getActiveRunIds(): string[];
  clear(): void;
}

export interface CleanupContext {
  db?: Database | OwnedDatabase;
  dir?: string;
  dbFileName?: string;
  outboxWorker?: StoppableWorker;
  executionRegistry?: ExecutionRegistryHandle;
  executionTimeoutMs?: number;
}

export function getDbPath(dir: string, dbFileName: string = "test.db"): string {
  return join(dir, dbFileName);
}

function normalizeError(error: unknown, stage: string): Error {
  if (error instanceof Error) {
    error.message = `[${stage}] ${error.message}`;
    return error;
  }
  return new Error(`[${stage}] ${String(error)}`);
}

function resolveOwned(db: Database | OwnedDatabase | undefined): { instance: Database | null; owned: OwnedDatabase | null } {
  if (!db) return { instance: null, owned: null };
  if ("closed" in db && "db" in db) {
    return { instance: (db as OwnedDatabase).db, owned: db as OwnedDatabase };
  }
  return { instance: db as Database, owned: null };
}

export async function deterministicCleanup(ctx: CleanupContext): Promise<void> {
  const { dir, dbFileName, outboxWorker, executionRegistry } = ctx;
  const fileName = dbFileName ?? "test.db";
  const failures: Error[] = [];
  const { instance: dbInstance, owned } = resolveOwned(ctx.db);

  // Stage 1: Stop outbox and polling workers
  if (outboxWorker) {
    try {
      await Promise.resolve(outboxWorker.stop());
    } catch (error) {
      failures.push(normalizeError(error, "worker-stop"));
    }
  }

  // Stage 2: Cancel active executions
  if (executionRegistry) {
    const activeIds = executionRegistry.getActiveRunIds();
    for (const runId of activeIds) {
      try {
        const result = await executionRegistry.cancelRunExecution(runId, "runtime_cleanup", ctx.executionTimeoutMs);
        if (result.timedOut) {
          failures.push(new Error(`[execution-cancel] run ${runId} timed out`));
        }
        for (const ce of result.cleanupErrors) {
          failures.push(normalizeError(ce, `execution-cleanup-${runId}`));
        }
      } catch (error) {
        failures.push(normalizeError(error, `execution-cancel-${runId}`));
      }
    }

    // Verify termination before clearing
    const remaining = executionRegistry.getActiveRunIds();
    if (remaining.length > 0) {
      failures.push(new Error(`[execution-leak] ${remaining.length} active run(s) remain: ${remaining.join(", ")}`));
    }

    try {
      executionRegistry.clear();
    } catch (error) {
      failures.push(normalizeError(error, "registry-clear"));
    }
  }

  // Stage 3: WAL checkpoint (non-blocking)
  if (dbInstance && !(owned?.closed)) {
    try {
      const row = dbInstance.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
        busy: number;
        log: number;
        checkpointed: number;
      } | undefined;
      if (row && typeof row === "object") {
        if (row.busy > 0) {
          failures.push(new Error(`[wal-checkpoint] ${row.busy} reader(s) still busy after PASSIVE checkpoint`));
        }
        const uncheckpointed = row.log - row.checkpointed;
        if (uncheckpointed > 0) {
          failures.push(new Error(`[wal-checkpoint] ${uncheckpointed} frame(s) remain uncheckpointed`));
        }
      }
    } catch {
      // Not all databases use WAL mode; skip diagnostics
    }
  }

  // Stage 4: Close SQLite connection exactly once
  if (dbInstance && !(owned?.closed)) {
    try {
      dbInstance.close();
      if (owned) {
        owned.closed = true;
      }
    } catch (error) {
      failures.push(normalizeError(error, "sqlite-close"));
    }
  }

  // Wait for OS to release file handles (critical on Windows)
  await new Promise((r) => setTimeout(r, 50));

  // Safe async rm wrapper: rmSync can hang on Windows locked files
  const rmSafe = (f: string, opts: { recursive?: boolean; force?: boolean }): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 200);
      try {
        rmSync(f, opts);
        clearTimeout(timer);
        resolve(true);
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });

  // Stage 5: Delete database files (best-effort with retry)
  const deleteFile = async (f: string): Promise<boolean> => {
    if (!existsSync(f)) return true;
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const ok = await rmSafe(f, { force: true });
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  if (dir && existsSync(dir)) {
    const dbPath = join(dir, fileName);
    const walPath = dbPath + "-wal";
    const shmPath = dbPath + "-shm";

    for (const f of [dbPath, walPath, shmPath]) {
      await deleteFile(f);
    }

    // Stage 6: Delete temporary directory (best-effort)
    if (existsSync(dir)) {
      const deadline = Date.now() + 800;
      let ok = false;
      while (Date.now() < deadline && !ok) {
        ok = await rmSafe(dir, { recursive: true, force: true });
        if (!ok) await new Promise((r) => setTimeout(r, 100));
      }
    }

    // Stage 7: Verify final state
    if (existsSync(dbPath)) {
      failures.push(new Error("[verify] DB_FILE_LEAK"));
    }
    if (existsSync(walPath)) {
      failures.push(new Error("[verify] WAL_FILE_LEAK"));
    }
    if (existsSync(shmPath)) {
      failures.push(new Error("[verify] SHM_FILE_LEAK"));
    }
    if (existsSync(dir)) {
      failures.push(new Error("[verify] TEMP_DIRECTORY_LEAK"));
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "ORCHESTRATION_CLEANUP_FAILED");
  }
}
