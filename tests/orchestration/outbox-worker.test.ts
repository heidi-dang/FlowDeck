import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { OutboxWorker } from "../../src/orchestration/services/outbox-worker";
import type { IDeliverySink, IEventBus, DeliveryRecord } from "../../src/orchestration/services/ports";

class MockDeliverySink implements IDeliverySink {
  public entries = new Map<string, any>();

  async claimDue(workerId: string, batchSize: number, leaseSeconds: number) {
    const now = Math.floor(Date.now() / 1000);
    const due = Array.from(this.entries.values())
      .filter((e) => e.status === "pending" || (e.status === "delivering" && e.lease && e.lease.leaseUntil < now))
      .slice(0, batchSize);
    return due.map((e) => {
      const record: DeliveryRecord = { ...e, status: "delivering", lease: { workerId, leaseUntil: now + leaseSeconds } };
      this.entries.set(e.id, record);
      return record;
    });
  }

  async markDelivered(id: string, _idempotencyKey?: string) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.status = "delivered";
    return true;
  }

  async markFailed(id: string, attemptCount: number, lastError: string, maxRetries: number) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.status = attemptCount >= maxRetries ? "failed" : "pending";
    entry.attemptCount = attemptCount;
    entry.lastError = lastError;
  }

  async requeueExpiredLeases(_nowSeconds?: number) { return 0; }
  async countByStatus(_status: string) { return 0; }
  async recordDelivery(_delivery: { eventId: string; destination: string; status: string; attempt: number; durationMs?: number; error?: string }) {}
  async recordDeadLetter(_deadLetter: { eventId: string; destination: string; reason: string; lastError?: string; payload?: Record<string, unknown> }) {}
}

class MockEventBus implements IEventBus {
  public published: any[] = [];
  public shouldFail = false;

  async publish(event: any) {
    if (this.shouldFail) {
      throw new Error("EventBus delivery failure");
    }
    this.published.push(event);
  }
  subscribe() { return () => {}; }
  subscribeAll() { return () => {}; }
  getSubscriberCount() { return 0; }
}

describe("OutboxWorker Unit Tests", () => {
  let sink: MockDeliverySink;
  let eventBus: MockEventBus;
  let worker: OutboxWorker;

  beforeEach(() => {
    sink = new MockDeliverySink();
    eventBus = new MockEventBus();
    worker = new OutboxWorker(sink, eventBus);
  });

  afterEach(() => {
    worker.stop();
  });

  it("processes pending outbox records and marks them DELIVERED", async () => {
    sink.entries.set("ob-1", {
      id: "ob-1",
      eventId: "e-1",
      eventType: "TestEvent",
      aggregateId: "agg-1",
      correlationId: "c-1",
      payload: { foo: "bar" },
      status: "pending",
      attemptCount: 0,
      maxRetries: 3,
    });

    const res = await worker.processBatch();
    expect(res.processed).toBe(1);
    expect(res.failed).toBe(0);
    expect(eventBus.published.length).toBe(1);
    expect(eventBus.published[0].id).toBe("e-1");
    expect(sink.entries.get("ob-1").status).toBe("delivered");
  });

  it("handles event publication failure and increments attempt count", async () => {
    sink.entries.set("ob-2", {
      id: "ob-2",
      eventId: "e-2",
      eventType: "FailEvent",
      aggregateId: "agg-2",
      correlationId: "c-2",
      payload: {},
      status: "pending",
      attemptCount: 0,
      maxRetries: 1,
    });

    eventBus.shouldFail = true;

    const res = await worker.processBatch();
    expect(res.processed).toBe(0);
    expect(res.failed).toBe(1);
    expect(sink.entries.get("ob-2").status).toBe("failed");
    expect(sink.entries.get("ob-2").attemptCount).toBe(1);
    expect(sink.entries.get("ob-2").lastError).toContain("EventBus delivery failure");
  });

  it("does not process entries under another worker's active lease", async () => {
    const now = Math.floor(Date.now() / 1000);
    sink.entries.set("ob-3", {
      id: "ob-3",
      eventId: "e-3",
      eventType: "TestEvent",
      aggregateId: "agg-3",
      correlationId: "c-3",
      payload: {},
      status: "delivering",
      attemptCount: 0,
      maxRetries: 3,
      lease: { workerId: "other-worker", leaseUntil: now + 120 },
    });

    const res = await worker.processBatch();
    expect(res.processed).toBe(0);
    expect(res.failed).toBe(0);
    expect(eventBus.published.length).toBe(0);
    expect(sink.entries.get("ob-3").lease.workerId).toBe("other-worker");
  });

  it("starts and stops periodic background worker cleanly", async () => {
    worker.start(10);
    // Double start is no-op
    worker.start(10);

    await new Promise(r => setTimeout(r, 30));
    worker.stop();
    worker.stop();
  });
});
