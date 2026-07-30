import { Database } from "bun:sqlite";
import { rmSync, existsSync } from "fs";
import { join } from "path";

export interface CleanupContext {
  db?: Database;
  dir?: string;
  dbFileName?: string;
  outboxWorker?: { stop: () => void };
  executionRegistry?: {
    clear?: () => void;
    cancelRunExecution?: (id: string, reason?: string) => Promise<unknown>;
    getActiveRunIds?: () => string[];
    resolveExecution?: (id: string) => void;
  };
}

export function getDbPath(dir: string, dbFileName: string = "test.db"): string {
  return join(dir, dbFileName);
}

export function deterministicCleanup(ctx: CleanupContext): void {
  const { db, dir, dbFileName, outboxWorker, executionRegistry } = ctx;
  const fileName = dbFileName ?? "test.db";

  // 1. Stop active workers
  if (outboxWorker) {
    outboxWorker.stop();
  }

  // 2. Cancel active executions
  if (executionRegistry) {
    const activeIds = executionRegistry.getActiveRunIds?.() ?? [];
    for (const id of activeIds) {
      try {
        executionRegistry.resolveExecution?.(id);
      } catch (e) {
        console.error(`[cleanup] resolveExecution ${id}:`, e);
      }
    }
    try {
      executionRegistry.clear?.();
    } catch (e) {
      console.error("[cleanup] clear executionRegistry:", e);
    }
  }

  // 3. Close the database connection
  if (db) {
    try {
      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch {
      // not all databases use WAL; DB may already be closed
    }
    try {
      db.close();
    } catch {
      // DB may already be closed — that's fine
    }
  }

  // 4. Remove DB, WAL and SHM files
  if (dir && existsSync(dir)) {
    const dbPath = join(dir, fileName);
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = dbPath + suffix;
      try {
        if (existsSync(f)) {
          rmSync(f, { force: true });
        }
      } catch (e) {
        console.error(`[cleanup] rm ${f}:`, e);
      }
    }

    // 5. Remove temporary directory
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.error(`[cleanup] rm ${dir}:`, e);
    }
  }
}
