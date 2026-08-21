import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTransactionManager } from "../../../src/orchestration/persistence/transaction-manager";
import { SqliteOutboxRepository } from "../../../src/orchestration/persistence/adapters/sqlite-outbox-repository";

describe("SqliteOutboxRepository Coverage", () => {
  let db: Database;
  let repo: SqliteOutboxRepository;

  beforeEach(() => {
    db = new Database(":memory:");
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
    const tx = createTransactionManager(db);
    repo = new SqliteOutboxRepository(db, tx);
  });

  afterEach(() => {
    db.close();
  });

  it("handles malformed JSON data in rowToEntry", async () => {
    db.query(`
      INSERT INTO event_outbox (id, event_id, event_type, aggregate_id, data, status, retry_count, last_error, idempotency_key, source_component, created_ts)
      VALUES ('bad-json', 'e1', 'type1', 'agg1', '{invalid-json', 'pending', 0, 'existing err', 'ik1', 'orchestration', 12345)
    `).run();

    const entry = await repo.findById("bad-json");
    expect(entry).not.toBeNull();
    expect(entry?.lastError).toContain("JSON decode error");
    expect(entry?.lastError).toContain("existing err");
  });

  it("handles update with various fields and non-existent id", async () => {
    const none = await repo.update("non-existent", { status: "pending" });
    expect(none).toBeNull();

    await repo.create({
      id: "o1",
      eventId: "e1",
      eventType: "type1",
      status: "pending",
      correlationId: "c1",
      aggregateId: "agg1",
      payload: { foo: "bar" },
      attemptCount: 0,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const updated = await repo.update("o1", {
      status: "failed",
      lastError: "some err",
      attemptCount: 1,
      retryCount: 1,
      deliveredAt: "2026-01-01T00:00:00.000Z",
    });

    expect(updated?.status).toBe("delivered");
    expect(updated?.lastError).toBe("some err");
  });

  it("handles findMany and count with filters", async () => {
    await repo.create({
      id: "o1",
      eventId: "e1",
      eventType: "type1",
      status: "pending",
      correlationId: "c1",
      aggregateId: "agg1",
      payload: { msg: "plain string payload" },
      attemptCount: 0,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await repo.findMany({ status: "pending", destination: "orchestration", correlationId: "c1" }, { page: 1, limit: 10 });
    expect(res.total).toBe(1);
    expect(res.items.length).toBe(1);

    const cnt = await repo.count({ status: "pending", destination: "orchestration", correlationId: "c1" });
    expect(cnt).toBe(1);

    const pending = await repo.findPending();
    expect(pending.length).toBe(1);
  });

  it("handles claimNextBatch and markDelivered", async () => {
    await repo.create({
      id: "o1",
      eventId: "e1",
      eventType: "type1",
      status: "pending",
      correlationId: "c1",
      aggregateId: "agg1",
      payload: {},
      attemptCount: 0,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const batch = await repo.claimNextBatch(5);
    expect(batch.length).toBe(1);
    expect(batch[0].status).toBe("pending");

    await repo.markDelivered("o1", "c1");
    const found = await repo.findById("o1");
    expect(found?.status).toBe("delivered");

    // repeat delivery (idempotent)
    await repo.markDelivered("o1", "c1");
    expect((await repo.findById("o1"))?.status).toBe("delivered");
  });
});
