/**
 * SqliteDeliverySink — durable, idempotent, lease-based delivery coverage
 * against a real SQLite database, plus an end-to-end OutboxWorker run.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner";
import { createTransactionManager } from "../../../src/orchestration/persistence/transaction-manager";
import { SqliteDeliverySink } from "../../../src/orchestration/persistence/adapters/sqlite-delivery-sink";
import { SqliteOutboxRepository } from "../../../src/orchestration/persistence/adapters/sqlite-outbox-repository";
import { OutboxWorker } from "../../../src/orchestration/services/outbox-worker";
import { InMemoryEventBus } from "../../../src/orchestration/services/event-bus-impl";
import type { OutboxEntry } from "../../../src/orchestration/types/outbox";

function makeEntry(id: string, correlationId: string): OutboxEntry {
  return {
    id,
    destination: "internal",
    eventId: `evt-${id}`,
    eventType: "run.progress",
    payload: { marker: id },
    correlationId,
    status: "pending",
    attemptCount: 0,
    retryCount: 0,
    maxRetries: 3,
    createdAt: new Date().toISOString(),
  };
}

describe("SqliteDeliverySink", () => {
  let db: Database;
  let sink: SqliteDeliverySink;
  let outbox: SqliteOutboxRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    sink = new SqliteDeliverySink(db, createTransactionManager(db));
    outbox = new SqliteOutboxRepository(db, createTransactionManager(db));
  });

  afterEach(() => {
    db.close();
  });

  it("claims pending entries with a lease and transitions them to delivering", async () => {
    await outbox.create(makeEntry("ob-1", "c-1"));
    await outbox.create(makeEntry("ob-2", "c-2"));

    const claimed = await sink.claimDue("worker-a", 10, 60);
    expect(claimed.length).toBe(2);
    expect(claimed[0].status).toBe("delivering");
    expect(claimed[0].lease?.workerId).toBe("worker-a");
    expect(claimed[0].lease!.leaseUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));

    expect(await sink.countByStatus("delivering")).toBe(2);
    expect(await sink.countByStatus("pending")).toBe(0);
  });

  it("respects batch size", async () => {
    await outbox.create(makeEntry("ob-1", "c-1"));
    await outbox.create(makeEntry("ob-2", "c-2"));
    await outbox.create(makeEntry("ob-3", "c-3"));

    const claimed = await sink.claimDue("worker-a", 2, 60);
    expect(claimed.length).toBe(2);
  });

  it("does not reclaim entries under an active lease", async () => {
    await outbox.create(makeEntry("ob-1", "c-1"));
    await sink.claimDue("worker-a", 10, 60);

    const again = await sink.claimDue("worker-b", 10, 60);
    expect(again.length).toBe(0);
  });

  it("reclaims entries whose lease expired (crash recovery)", async () => {
    await outbox.create(makeEntry("ob-1", "c-1"));
    await sink.claimDue("worker-a", 10, 60);

    // Force the lease to expire.
    const expired = Math.floor(Date.now() / 1000) - 10;
    db.query("UPDATE event_outbox SET last_error = ? WHERE id = ?")
      .run(JSON.stringify({ workerId: "worker-a", leaseUntil: expired }), "ob-1");

    const reclaimed = await sink.claimDue("worker-b", 10, 60);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0].lease?.workerId).toBe("worker-b");
  });

  it("requeueExpiredLeases returns expired entries to pending", async () => {
    await outbox.create(makeEntry("ob-1", "c-1"));
    await outbox.create(makeEntry("ob-2", "c-2"));
    await sink.claimDue("worker-a", 10, 60);

    const now = Math.floor(Date.now() / 1000);
    db.query("UPDATE event_outbox SET last_error = ? WHERE id = 'ob-1'")
      .run(JSON.stringify({ workerId: "worker-a", leaseUntil: now - 5 }));

    const requeued = await sink.requeueExpiredLeases();
    expect(requeued).toBe(1);
    expect(await sink.countByStatus("pending")).toBe(1);
    expect(await sink.countByStatus("delivering")).toBe(1);

    // The requeued entry can now be claimed and delivered.
    const claimed = await sink.claimDue("worker-b", 10, 60);
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe("ob-1");
  });

  it("markDelivered is idempotent and guarded by status", async () => {
    await outbox.create(makeEntry("ob-1", "c-1"));
    await sink.claimDue("worker-a", 10, 60);

    expect(await sink.markDelivered("ob-1", "c-1")).toBe(true);
    expect(await sink.countByStatus("delivered")).toBe(1);

    // Second delivery attempt is idempotent success.
    expect(await sink.markDelivered("ob-1", "c-1")).toBe(true);

    // Unknown or non-delivering entries cannot be marked delivered.
    expect(await sink.markDelivered("missing", "c-1")).toBe(false);
  });

  it("markFailed requeues until maxRetries then fails", async () => {
    await outbox.create(makeEntry("ob-1", "c-1"));

    await sink.markFailed("ob-1", 1, "boom", 3);
    expect(await sink.countByStatus("pending")).toBe(1);

    await sink.markFailed("ob-1", 2, "boom", 3);
    expect(await sink.countByStatus("pending")).toBe(1);

    await sink.markFailed("ob-1", 3, "boom", 3);
    expect(await sink.countByStatus("failed")).toBe(1);

    const row = db.query("SELECT retry_count, last_error FROM event_outbox WHERE id = ?").get("ob-1") as { retry_count: number; last_error: string };
    expect(row.retry_count).toBe(3);
    expect(row.last_error).toBe("boom");
  });

  it("countByStatus counts correctly", async () => {
    await outbox.create(makeEntry("ob-1", "c-1"));
    await outbox.create(makeEntry("ob-2", "c-2"));
    expect(await sink.countByStatus("pending")).toBe(2);
    expect(await sink.countByStatus("delivered")).toBe(0);
  });
});

describe("OutboxWorker with real delivery sink (end-to-end)", () => {
  let db: Database;
  let outbox: SqliteOutboxRepository;
  let sink: SqliteDeliverySink;
  let bus: InMemoryEventBus;
  let worker: OutboxWorker;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    outbox = new SqliteOutboxRepository(db, createTransactionManager(db));
    sink = new SqliteDeliverySink(db, createTransactionManager(db));
    bus = new InMemoryEventBus();
    worker = new OutboxWorker(sink, bus, { workerId: "test-worker", batchSize: 10, leaseSeconds: 60 });
  });

  afterEach(() => {
    worker.stop();
    db.close();
  });

  it("delivers pending entries through the sink to the bus exactly once", async () => {
    await outbox.create(makeEntry("ob-1", "c-1"));
    await outbox.create(makeEntry("ob-2", "c-2"));

    let published = 0;
    bus.subscribeAll(() => { published++; });

    const res = await worker.processBatch();
    expect(res.processed).toBe(2);
    expect(res.failed).toBe(0);
    expect(published).toBe(2);
    expect(await sink.countByStatus("delivered")).toBe(2);

    // No entries remain due.
    const res2 = await worker.processBatch();
    expect(res2.processed).toBe(0);
    expect(res2.failed).toBe(0);
  });

  it("requeues entries stuck delivering after lease expiry and delivers them", async () => {
    await outbox.create(makeEntry("ob-1", "c-1"));
    await sink.claimDue("crashed-worker", 10, 60);

    // Simulate worker crash: lease expires, entry stays 'delivering'.
    const expired = Math.floor(Date.now() / 1000) - 30;
    db.query("UPDATE event_outbox SET last_error = ? WHERE id = ?")
      .run(JSON.stringify({ workerId: "crashed-worker", leaseUntil: expired }), "ob-1");

    // A fresh worker run claims it again and delivers.
    const res = await worker.processBatch();
    expect(res.processed).toBe(1);
    expect(res.failed).toBe(0);
    expect(await sink.countByStatus("delivered")).toBe(1);
  });
});
