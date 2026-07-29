import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { OutboxWorker } from "../../src/orchestration/services/outbox-worker";
import { OutboxStatus } from "../../src/orchestration/types/outbox";
import type { IOutboxRepository, IEventBus } from "../../src/orchestration/services/ports";

class MockOutboxRepo implements IOutboxRepository {
  public entries = new Map<string, any>();

  async create(entry: any) { this.entries.set(entry.id, { ...entry, status: OutboxStatus.PENDING, attemptCount: 0 }); return entry; }
  async findById(id: string) { return this.entries.get(id) ?? null; }
  async update(id: string, input: any) {
    const existing = this.entries.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...input };
    this.entries.set(id, updated);
    return updated;
  }
  async findMany(_filter?: any, pagination?: any) {
    const items = Array.from(this.entries.values()).filter(e => _filter?.status ? e.status === _filter.status : true);
    return { items, total: items.length, page: 1, limit: pagination?.limit ?? 50 };
  }
  async findPending() {
    return Array.from(this.entries.values()).filter(e => e.status === OutboxStatus.PENDING);
  }
  async count(_filter?: any) { return this.entries.size; }
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
  let repo: MockOutboxRepo;
  let eventBus: MockEventBus;
  let worker: OutboxWorker;

  beforeEach(() => {
    repo = new MockOutboxRepo();
    eventBus = new MockEventBus();
    worker = new OutboxWorker(repo, eventBus);
  });

  afterEach(() => {
    worker.stop();
  });

  it("processes pending outbox records and marks them DELIVERED", async () => {
    await repo.create({
      id: "ob-1",
      eventId: "e-1",
      eventType: "TestEvent",
      aggregateId: "agg-1",
      correlationId: "c-1",
      payload: { foo: "bar" },
      createdAt: new Date().toISOString(),
      maxRetries: 3,
    });

    const res = await worker.processBatch();
    expect(res.processed).toBe(1);
    expect(res.failed).toBe(0);
    expect(eventBus.published.length).toBe(1);
    expect(repo.entries.get("ob-1").status).toBe(OutboxStatus.DELIVERED);
  });

  it("handles event publication failure and increments attempt count", async () => {
    await repo.create({
      id: "ob-2",
      eventId: "e-2",
      eventType: "FailEvent",
      aggregateId: "agg-2",
      correlationId: "c-2",
      payload: {},
      createdAt: new Date().toISOString(),
      maxRetries: 1,
    });

    eventBus.shouldFail = true;

    const res = await worker.processBatch();
    expect(res.processed).toBe(0);
    expect(res.failed).toBe(1);
    expect(repo.entries.get("ob-2").status).toBe(OutboxStatus.FAILED);
    expect(repo.entries.get("ob-2").attemptCount).toBe(1);
    expect(repo.entries.get("ob-2").lastError).toContain("EventBus delivery failure");
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
