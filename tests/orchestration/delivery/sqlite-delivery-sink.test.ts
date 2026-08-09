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

// ─── recordDelivery and recordDeadLetter ─────────────────────────────────────

describe("SqliteDeliverySink — recordDelivery", () => {
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

  it("inserts a new event_deliveries row on first call", async () => {
    await outbox.create(makeEntry("ob-1", "c-1"));

    await sink.recordDelivery({
      eventId: "evt-ob-1",
      destination: "my-service",
      status: "delivered",
      attempt: 1,
      durationMs: 50,
    });

    const row = db
      .query("SELECT * FROM event_deliveries LIMIT 1")
      .get() as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!.status).toBe("delivered");
    expect(row!.delivery_attempts).toBe(1);
    expect(row!.delivered_at).not.toBeNull();
    expect(row!.last_error).toBeNull();
  });

  it("upserts on second call (updates the existing row)", async () => {
    await outbox.create(makeEntry("ob-2", "c-2"));

    await sink.recordDelivery({
      eventId: "evt-ob-2",
      destination: "svc-a",
      status: "failed",
      attempt: 1,
      error: "timeout",
    });
    await sink.recordDelivery({
      eventId: "evt-ob-2",
      destination: "svc-a",
      status: "delivered",
      attempt: 2,
    });

    const rows = db.query("SELECT * FROM event_deliveries").all() as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("delivered");
    expect(rows[0].delivery_attempts).toBe(2);
    // delivered_at was null on first insert (failed status) and now set on upsert
    expect(rows[0].delivered_at).not.toBeNull();
    // last_error retained from first call (COALESCE keeps old value when new is null)
    expect(rows[0].last_error).toBe("timeout");
  });

  it("records last_error and last_error_ts when an error is provided", async () => {
    await outbox.create(makeEntry("ob-3", "c-3"));

    await sink.recordDelivery({
      eventId: "evt-ob-3",
      destination: "svc-b",
      status: "failed",
      attempt: 1,
      error: "Network timeout",
    });

    const row = db
      .query("SELECT last_error, last_error_ts FROM event_deliveries LIMIT 1")
      .get() as { last_error: string; last_error_ts: string };

    expect(row.last_error).toBe("Network timeout");
    expect(row.last_error_ts).not.toBeNull();
  });

  it("creates subscriber and outbox entries automatically when they do not exist", async () => {
    // No prior outbox row — recordDelivery must synthesise the required FK rows.
    await sink.recordDelivery({
      eventId: "synthetic-event-id",
      destination: "auto-created-subscriber",
      status: "delivered",
      attempt: 1,
    });

    const sub = db
      .query("SELECT id FROM event_subscribers WHERE name = 'auto-created-subscriber'")
      .get() as { id: string } | undefined;
    expect(sub).toBeDefined();

    const outboxRow = db
      .query("SELECT id FROM event_outbox WHERE id = 'synthetic-event-id'")
      .get() as { id: string } | undefined;
    expect(outboxRow).toBeDefined();

    const delivery = db.query("SELECT status FROM event_deliveries LIMIT 1").get() as { status: string } | undefined;
    expect(delivery?.status).toBe("delivered");
  });
});

describe("SqliteDeliverySink — recordDeadLetter", () => {
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

  it("inserts into dead_letter_events and creates a delivery row when none exists", async () => {
    await outbox.create(makeEntry("ob-dl-1", "c-dl-1"));

    await sink.recordDeadLetter({
      eventId: "evt-ob-dl-1",
      destination: "dl-consumer",
      reason: "Max retries exceeded",
      lastError: "500 Internal Server Error",
      payload: { foo: "bar" },
    });

    const dlRow = db
      .query("SELECT * FROM dead_letter_events LIMIT 1")
      .get() as Record<string, unknown> | undefined;

    expect(dlRow).toBeDefined();
    expect(dlRow!.final_error).toBe("Max retries exceeded");
    expect(dlRow!.status).toBe("unresolved");
    expect(dlRow!.event_payload).toBe(JSON.stringify({ foo: "bar" }));
    expect(dlRow!.error_history).toBe(JSON.stringify(["500 Internal Server Error"]));

    const deliveryRow = db
      .query("SELECT status, last_error FROM event_deliveries LIMIT 1")
      .get() as { status: string; last_error: string } | undefined;

    expect(deliveryRow).toBeDefined();
    expect(deliveryRow!.status).toBe("dead_letter");
    expect(deliveryRow!.last_error).toBe("Max retries exceeded");
  });

  it("updates an existing delivery row to dead_letter status", async () => {
    await outbox.create(makeEntry("ob-dl-2", "c-dl-2"));

    // First record a normal delivery attempt
    await sink.recordDelivery({
      eventId: "evt-ob-dl-2",
      destination: "dl-consumer",
      status: "failed",
      attempt: 3,
      error: "Persistent error",
    });

    // Then dead-letter it
    await sink.recordDeadLetter({
      eventId: "evt-ob-dl-2",
      destination: "dl-consumer",
      reason: "Poison pill message",
      payload: { id: 42 },
    });

    // Only one delivery row should exist
    const deliveryRows = db.query("SELECT status FROM event_deliveries").all() as { status: string }[];
    expect(deliveryRows.length).toBe(1);
    expect(deliveryRows[0].status).toBe("dead_letter");

    const dlRow = db
      .query("SELECT final_error, event_payload, error_history FROM dead_letter_events LIMIT 1")
      .get() as { final_error: string; event_payload: string; error_history: string } | undefined;

    expect(dlRow).toBeDefined();
    expect(dlRow!.final_error).toBe("Poison pill message");
    expect(dlRow!.event_payload).toBe(JSON.stringify({ id: 42 }));
    // No lastError provided, so error_history falls back to [reason]
    expect(dlRow!.error_history).toBe(JSON.stringify(["Poison pill message"]));
  });

  it("falls back to empty payload object when payload is omitted", async () => {
    await sink.recordDeadLetter({
      eventId: "bare-event",
      destination: "bare-consumer",
      reason: "Unknown error",
    });

    const dlRow = db
      .query("SELECT event_payload FROM dead_letter_events LIMIT 1")
      .get() as { event_payload: string } | undefined;

    expect(dlRow).toBeDefined();
    expect(dlRow!.event_payload).toBe("{}");
  });

  it("satisfies FK constraints when PRAGMA foreign_keys is ON", async () => {
    // Re-open a fresh DB with FK enforcement enabled
    const fkDb = new Database(":memory:");
    fkDb.query("PRAGMA foreign_keys = ON").run();
    runMigrations(fkDb);
    const fkSink = new SqliteDeliverySink(fkDb, createTransactionManager(fkDb));

    // Should not throw — ensureSubscriber / ensureEventAndOutbox creates all required rows.
    await expect(
      fkSink.recordDelivery({
        eventId: "fk-event-1",
        destination: "fk-sub",
        status: "delivered",
        attempt: 1,
      }),
    ).resolves.toBeUndefined();

    await expect(
      fkSink.recordDeadLetter({
        eventId: "fk-event-2",
        destination: "fk-sub-2",
        reason: "FK test failure",
        payload: { test: true },
      }),
    ).resolves.toBeUndefined();

    fkDb.close();
  });
});
