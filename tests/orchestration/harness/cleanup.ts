import { Database, constants } from "bun:sqlite";
import { existsSync } from "fs";
import { rm } from "node:fs/promises";
import { join } from "path";

interface BunSqliteDatabaseWithCache extends Database {
  clearQueryCache?: () => void;
}

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

export interface CleanupHooks {
  closeDatabase?: (db: Database, throwOnError: boolean) => void;
}

export interface CleanupContext {
  db?: Database | OwnedDatabase;
  dir?: string;
  dbFileName?: string;
  outboxWorker?: StoppableWorker;
  executionRegistry?: ExecutionRegistryHandle;
  executionTimeoutMs?: number;
  /** Additional SQLite connections to close strictly before directory removal */
  extraConnections?: Database[];
  /** Test-only close hook for deterministic failure propagation coverage. */
  hooks?: CleanupHooks;
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

/**
 * Strict-close a single SQLite connection and surface any actual close error.
 *
 * Bun SQLite may safely finalize prepared statements during `close(true)`. A
 * successful close is authoritative; a failed close is retained as a cleanup
 * diagnostic, followed by best-effort non-strict release and leak checks.
 */
function strictClose(
  db: Database,
  role: string,
  closeDatabase: (db: Database, throwOnError: boolean) => void,
): Error | null {
  try {
    (db as BunSqliteDatabaseWithCache).clearQueryCache?.();
    Bun.gc(true);
    closeDatabase(db, true);
    return null;
  } catch (error) {
    try { db.close(false); } catch {} 
    return normalizeError(error, `sqlite-strict-close-${role}`);
  }
}

/** Shut down WAL cleanly so the backing files can be removed deterministically. */
function shutdownWal(db: Database): Error | null {
  try {
    const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
    const journalMode = mode && typeof mode === "object" ? String((mode as any).journal_mode ?? "") : "";
    if (journalMode.toUpperCase() !== "WAL") return null;
    try {
      db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
    } catch {
      // PERSIST_WAL is a best-effort hint; a checkpoint failure below is authoritative.
    }
    const row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    } | undefined;
    if (row && typeof row === "object") {
      if (row.busy > 0) {
        return new Error(`[wal-checkpoint] ${row.busy} reader(s) still busy after TRUNCATE checkpoint`);
      }
      const uncheckpointed = row.log - row.checkpointed;
      if (uncheckpointed > 0) {
        return new Error(`[wal-checkpoint] ${uncheckpointed} frame(s) remain uncheckpointed`);
      }
    }
    return null;
  } catch (error) {
    return normalizeError(error, "wal-checkpoint");
  }
}

/** Remove a single target with its own bounded retry budget. */
async function removeTarget(target: string, opts: { recursive?: boolean }): Promise<Error | null> {
  if (!existsSync(target)) return null;
  const started = Date.now();
  const rmOpts = { force: true, maxRetries: 10, retryDelay: 100, ...opts } as const;
  try {
    await rm(target, rmOpts);
    return null;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const code = err.code ?? "";
    const errno = err.errno ?? "";
    const syscall = err.syscall ?? "";
    const path = err.path ?? target;
    const elapsed = Date.now() - started;
    return new Error(
      `[file-remove] target=${target} code=${code} errno=${errno} syscall=${syscall} path=${path} elapsed=${elapsed}ms ${err.message ?? ""}`,
    );
  }
}

export async function deterministicCleanup(ctx: CleanupContext): Promise<void> {
  const { dir, dbFileName, outboxWorker, executionRegistry, extraConnections } = ctx;
  const closeDatabase = ctx.hooks?.closeDatabase ?? ((db: Database, throwOnError: boolean) => db.close(throwOnError));
  const fileName = dbFileName ?? "test.db";
  const failures: Error[] = [];
  const removalFailures: Error[] = [];
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

    const remaining = executionRegistry.getActiveRunIds();
    if (remaining.length > 0) {
      failures.push(new Error(`[execution-leak] ${remaining.length} active run(s) remain: ${remaining.join(", ")}`));
    } else {
      try {
        executionRegistry.clear();
      } catch (error) {
        failures.push(normalizeError(error, "registry-clear"));
      }
    }
  }

  // Stage 3: Strict-close every extra connection BEFORE the primary WAL
  // checkpoint. An extra connection holding a WAL read snapshot — even one
  // whose only activity is a read plus an open write transaction — blocks a
  // TRUNCATE checkpoint (busy: 1), so extras must be released first to get a
  // clean shutdown. Closing first also rolls back any open extra transaction.
  if (extraConnections) {
    for (let i = 0; i < extraConnections.length; i++) {
      const conn = extraConnections[i];
      const closeError = strictClose(conn, `extra-${i}`, closeDatabase);
      if (closeError) failures.push(closeError);
    }
  }

  // Stage 4: Shut down WAL and strict-close the owned primary connection
  if (dbInstance && !(owned?.closed)) {
    const walError = shutdownWal(dbInstance);
    if (walError) failures.push(walError);
    const closeError = strictClose(dbInstance, "primary", closeDatabase);
    if (closeError) failures.push(closeError);
    else if (owned) owned.closed = true;
  }

  // Stage 5: Remove files with bounded per-target retry (no shared deadline).
  // Each target gets its own maxRetries/retryDelay budget, so a locked file
  // cannot starve removal of the remaining files.
  if (dir && existsSync(dir)) {
    const dbPath = join(dir, fileName);
    const walPath = dbPath + "-wal";
    const shmPath = dbPath + "-shm";

    const errs = [
      await removeTarget(dbPath, {}),
      await removeTarget(walPath, {}),
      await removeTarget(shmPath, {}),
      await removeTarget(dir, { recursive: true }),
    ];
    for (const e of errs) {
      if (e) {
        removalFailures.push(e);
        failures.push(e);
      }
    }
  }

  // Stage 6: Verify final state. Supplement (do not replace) leak errors
  // with the underlying removal diagnostics.
  const removalDetail = (path: string): string => {
    const detail = removalFailures.find((e) => e.message.includes(`target=${path} `));
    return detail ? ` (removal failed: ${detail.message.replace(/^\[file-remove\] /, "")})` : "";
  };
  if (dir && existsSync(dir)) {
    const dbPath = join(dir, fileName);
    const walPath = dbPath + "-wal";
    const shmPath = dbPath + "-shm";
    if (existsSync(dbPath)) failures.push(new Error(`[verify] DB_FILE_LEAK (${dbPath})${removalDetail(dbPath)}`));
    if (existsSync(walPath)) failures.push(new Error(`[verify] WAL_FILE_LEAK (${walPath})${removalDetail(walPath)}`));
    if (existsSync(shmPath)) failures.push(new Error(`[verify] SHM_FILE_LEAK (${shmPath})${removalDetail(shmPath)}`));
    if (existsSync(dir)) failures.push(new Error(`[verify] TEMP_DIRECTORY_LEAK (${dir})${removalDetail(dir)}`));
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "ORCHESTRATION_CLEANUP_FAILED");
  }
}
