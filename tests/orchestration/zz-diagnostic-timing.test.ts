import { describe, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rm } from "node:fs/promises";
import { SCHEMA_V_0_2_6 } from "../../src/orchestration/persistence/migrations/schema-embed";

const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

async function measure(n: number, fn: () => Promise<unknown> | void): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return avg(samples);
}

const remove = (path: string, opts?: Record<string, unknown>) => rm(path, { force: true, ...opts }).catch(() => {});

describe("diagnostic timing", () => {
  it("measures per-phase costs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diag-base-"));
    const p = join(dir, "t.db");

    const t_schema_autocommit = await measure(3, async () => {
      const db = new Database(p);
      db.exec(SCHEMA_V_0_2_6);
      db.close();
      await remove(p);
    });

    const t_schema_wal_txn = await measure(3, async () => {
      const db = new Database(p);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("BEGIN");
      db.exec(SCHEMA_V_0_2_6);
      db.exec("COMMIT");
      db.close();
      await remove(p);
      await remove(p + "-wal");
      await remove(p + "-shm");
    });

    const t_close_permissive = await measure(3, async () => {
      const db = new Database(p);
      db.exec("CREATE TABLE t (x INTEGER)");
      db.close();
      await remove(p);
    });

    const t_close_strict = await measure(3, async () => {
      const db = new Database(p);
      db.exec("CREATE TABLE t (x INTEGER)");
      (db as any).clearQueryCache?.();
      Bun.gc(true);
      db.close(true);
      await remove(p);
    });

    const t_rm = await measure(3, async () => {
      const d = mkdtempSync(join(tmpdir(), "diag-rm-"));
      const db = new Database(join(d, "e.db"));
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("CREATE TABLE t (x INTEGER)");
      db.exec("INSERT INTO t VALUES (1)");
      db.close();
      await remove(join(d, "e.db"));
      await remove(join(d, "e.db-wal"));
      await remove(join(d, "e.db-shm"));
      await remove(d, { recursive: true });
    });

    const t_full_cycle = await measure(3, async () => {
      const d = mkdtempSync(join(tmpdir(), "diag-cyc-"));
      const db = new Database(join(d, "t.db"));
      db.exec(SCHEMA_V_0_2_6);
      db.exec("PRAGMA journal_mode=WAL");
      db.query("SELECT 1").get();
      (db as any).clearQueryCache?.();
      Bun.gc(true);
      db.close(true);
      await remove(join(d, "t.db"));
      await remove(join(d, "t.db-wal"));
      await remove(join(d, "t.db-shm"));
      await remove(d, { recursive: true });
    });

    console.log("DIAG_RESULTS", JSON.stringify({
      t_schema_autocommit,
      t_schema_wal_txn,
      t_close_permissive,
      t_close_strict,
      t_rm,
      t_full_cycle,
    }));
    await remove(dir, { recursive: true });
  });
});
