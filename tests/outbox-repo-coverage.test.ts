import { describe, it, expect } from "bun:test";
import { InMemoryOutboxRepository, matchesTopic } from "../src/domain/orchestration/runtime/outbox/in-memory-repo";
import { DEFAULT_RETRY_POLICY } from "../src/domain/orchestration/runtime/outbox/port";

describe("Domain Orchestration Outbox Repository Coverage", () => {
  function makeRecord(id: string, status: "pending" | "delivered" | "dead-lettered" = "pending") {
    const event: any = {
      eventId: `evt-${id}`,
      eventType: "RunCreated",
      payload: { x: 1 },
      aggregateId: `agg-${id}`,
      aggregateVersion: 1,
      globalSequence: 1,
      timestamp: new Date(),
      payloadHash: "hash123",
      checksum: "hash123:1:1",
      committedAt: new Date(),
      createdAt: new Date(),
    };
    return {
      recordId: `record-${id}`,
      aggregateId: `agg-${id}`,
      status,
      events: [event],
      deliveryAttempts: 0,
      errorMessage: "",
      createdAt: new Date(),
      nextRetryAt: null,
    };
  }

  it("matchesTopic returns true when topics match", () => {
    const event: any = { eventType: "RunCreated" };
    expect(matchesTopic(event, { topics: ["RunCreated"], subscriberId: "s1", handler: async () => {} } as any)).toBe(true);
    expect(matchesTopic(event, { topics: [], subscriberId: "s1", handler: async () => {} } as any)).toBe(true);
    expect(matchesTopic(event, { topics: ["RunFailed"], subscriberId: "s1", handler: async () => {} } as any)).toBe(false);
  });

  it("appendOutbox stores records by id and aggregate", async () => {
    const repo = new InMemoryOutboxRepository();
    const r1 = makeRecord("1") as any;
    const r2 = makeRecord("2") as any;
    await repo.appendOutbox([r1, r2]);

    const batch = await repo.claimBatch("wt-1", "owner-1", 1, 10);
    expect(batch).toBeDefined();
    expect(batch!.batchSize).toBe(2);
  });

  it("claimBatch returns null when no pending records", async () => {
    const repo = new InMemoryOutboxRepository();
    const result = await repo.claimBatch("wt-1", "owner-1", 1, 5);
    expect(result).toBeNull();
  });

  it("claimBatch returns null when claimed by different owner", async () => {
    const repo = new InMemoryOutboxRepository();
    await repo.appendOutbox([makeRecord("1") as any]);
    await repo.claimBatch("wt-1", "owner-1", 1, 5);
    const result = await repo.claimBatch("wt-1", "owner-2", 2, 5);
    expect(result).toBeNull();
  });

  it("retryFailedMessages increments retry count", async () => {
    const repo = new InMemoryOutboxRepository();
    await repo.appendOutbox([makeRecord("1") as any]);
    const count = await repo.retryFailedMessages(DEFAULT_RETRY_POLICY);
    expect(count).toBe(1);
  });

  it("getOffset returns null for unknown subscriber", async () => {
    const repo = new InMemoryOutboxRepository();
    const offset = await repo.getOffset("sub-1", "topic-1");
    expect(offset).toBeNull();
  });

  it("commitOffset and getOffset round-trip", async () => {
    const repo = new InMemoryOutboxRepository();
    const offset = { subscriberId: "sub-1", topic: "RunCreated", committedSequence: 5, committedAt: new Date() } as any;
    await repo.commitOffset(offset);
    const got = await repo.getOffset("sub-1", "RunCreated");
    expect(got?.committedSequence).toBe(5);
  });

  it("releaseExpiredClaims removes expired claims", async () => {
    const repo = new InMemoryOutboxRepository();
    await repo.appendOutbox([makeRecord("1") as any]);
    await repo.claimBatch("wt-1", "owner-1", 1, 5);

    const future = new Date(Date.now() + 60000);
    const released = await repo.releaseExpiredClaims(future);
    expect(released).toBe(1);
  });

  it("rejectStaleAcknowledgement returns false with no active claims", async () => {
    const repo = new InMemoryOutboxRepository();
    const rejected = await repo.rejectStaleAcknowledgement({ messageId: "m-1", token: 1 });
    expect(rejected).toBe(false);
  });

  it("moveToDeadLetter updates record status", async () => {
    const repo = new InMemoryOutboxRepository();
    const record = makeRecord("dlq") as any;
    await repo.appendOutbox([record]);
    const moved = await repo.moveToDeadLetter([`evt-dlq`]);
    expect(moved.length).toBe(1);
  });

  it("deliverMessages returns delivered and failed arrays", async () => {
    const repo = new InMemoryOutboxRepository();
    const message: any = {
      messageId: "msg-1",
      eventType: "RunCreated",
      payloadVersion: 1,
      payloadHash: "hash",
      aggregateId: "agg-1",
      globalSequence: 1,
      occurredAt: new Date(),
      payload: { x: 1 },
    };
    const claim: any = { claimId: "c-1", fencingToken: 1 };
    const result = await repo.deliverMessages(claim, [message]);
    expect(Array.isArray(result.delivered)).toBe(true);
    expect(Array.isArray(result.failed)).toBe(true);
    expect(Array.isArray(result.attempts)).toBe(true);
  });
});
