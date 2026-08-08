/**
 * SqliteReplayRepository — CRUD coverage against a real SQLite database
 * with the full migration chain (v1 schema + v2 replay migration) applied.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner";
import { createTransactionManager } from "../../../src/orchestration/persistence/transaction-manager";
import { SqliteReplayRepository } from "../../../src/orchestration/persistence/adapters/sqlite-replay-repository";
import type { Replay } from "../../../src/orchestration/types/replay";

function makeReplay(id: string, sourceRunId: string, overrides: Partial<Replay> = {}): Replay {
  const now = new Date().toISOString();
  return {
    id,
    sourceRunId,
    status: "pending",
    correlationId: `corr-${id}`,
    causationId: undefined,
    eventCount: 0,
    processedCount: 0,
    failedCount: 0,
    result: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
    completedAt: undefined,
    ...overrides,
  };
}

describe("SqliteReplayRepository", () => {
  let db: Database;
  let repo: SqliteReplayRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    repo = new SqliteReplayRepository(db, createTransactionManager(db));
  });

  afterEach(() => {
    db.close();
  });

  it("creates and finds a replay by id", async () => {
    const replay = makeReplay("r-1", "run-1");
    await repo.create(replay);

    const found = await repo.findById("r-1");
    expect(found).not.toBeNull();
    expect(found!.sourceRunId).toBe("run-1");
    expect(found!.status).toBe("pending");
    expect(found!.eventCount).toBe(0);
  });

  it("returns null for unknown id", async () => {
    expect(await repo.findById("missing")).toBeNull();
  });

  it("updates mutable fields and persists them", async () => {
    await repo.create(makeReplay("r-2", "run-2"));

    const updated = await repo.update("r-2", {
      status: "completed",
      eventCount: 5,
      processedCount: 5,
      failedCount: 0,
      result: { streamHash: "abc123" },
      completedAt: new Date().toISOString(),
    });

    expect(updated?.status).toBe("completed");
    expect(updated?.eventCount).toBe(5);
    expect((updated?.result as Record<string, unknown>).streamHash).toBe("abc123");

    const reloaded = await repo.findById("r-2");
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.processedCount).toBe(5);
  });

  it("returns null when updating an unknown id", async () => {
    expect(await repo.update("missing", { status: "failed" })).toBeNull();
  });

  it("lists replays with pagination", async () => {
    for (let i = 1; i <= 3; i++) await repo.create(makeReplay(`r-${i}`, `run-${i}`));

    const page = await repo.findMany({ page: 1, limit: 2 });
    expect(page.total).toBe(3);
    expect(page.items.length).toBe(2);

    const page2 = await repo.findMany({ page: 2, limit: 2 });
    expect(page2.items.length).toBe(1);
  });

  it("counts replays", async () => {
    expect(await repo.count()).toBe(0);
    await repo.create(makeReplay("r-9", "run-9"));
    expect(await repo.count()).toBe(1);
  });
});
