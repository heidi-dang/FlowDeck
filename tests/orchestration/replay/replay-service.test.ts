/**
 * ReplayService.runReplay — deterministic replay engine coverage.
 *
 * Uses a real SQLite replay repository (migrations applied) plus a mock
 * event repository to exercise both stream sources (provided events and
 * event-repository lookup) and every validation/conflict path.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner";
import { createTransactionManager } from "../../../src/orchestration/persistence/transaction-manager";
import { SqliteReplayRepository } from "../../../src/orchestration/persistence/adapters/sqlite-replay-repository";
import { ReplayService, validateReplayStream, hashReplayStream } from "../../../src/orchestration/services/replay-service";
import { InMemoryEventBus } from "../../../src/orchestration/services/event-bus-impl";
import { OrchestrationError, ErrorCodes } from "../../../src/orchestration/types/errors";
import type { OrchestrationEvent } from "../../../src/orchestration/types/events";
import type { IEventRepository } from "../../../src/orchestration/services/ports";
import type { Replay } from "../../../src/orchestration/types/replay";
import type { PagePaginationRequest } from "../../../src/orchestration/types/pagination";

function makeReplay(id: string, sourceRunId: string): Replay {
  const now = new Date().toISOString();
  return { id, sourceRunId, status: "pending", correlationId: `corr-${id}`, createdAt: now, updatedAt: now };
}

function makeEvent(id: string, runId: string, version: number): OrchestrationEvent {
  return {
    id, type: "run.progress", eventVersion: 1,
    timestamp: `2025-01-01T00:00:0${version}.000Z`,
    correlationId: runId, aggregateId: runId, aggregateVersion: version, data: { v: version }, metadata: {},
  };
}

class MockEventRepo implements IEventRepository {
  public events: OrchestrationEvent[] = [];
  async store(e: OrchestrationEvent): Promise<OrchestrationEvent> { this.events.push(e); return e; }
  async findById(id: string): Promise<OrchestrationEvent | null> { return this.events.find((e) => e.id === id) ?? null; }
  async findMany(_filter: unknown, _pagination: PagePaginationRequest) { return { items: this.events, total: this.events.length, page: 1, limit: 20 }; }
  async count(): Promise<number> { return this.events.length; }
  async findByRunId(runId: string): Promise<OrchestrationEvent[]> {
    return this.events.filter((e) => e.aggregateId === runId).sort((a, b) => (a.aggregateVersion ?? 0) - (b.aggregateVersion ?? 0));
  }
}

describe("ReplayService", () => {
  let db: Database;
  let repo: SqliteReplayRepository;
  let bus: InMemoryEventBus;
  let eventRepo: MockEventRepo;
  let service: ReplayService;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    repo = new SqliteReplayRepository(db, createTransactionManager(db));
    bus = new InMemoryEventBus();
    eventRepo = new MockEventRepo();
    service = new ReplayService(repo, bus, eventRepo);
  });

  afterEach(() => {
    db.close();
  });

  describe("validateReplayStream", () => {
    it("accepts a contiguous stream", () => {
      const result = validateReplayStream([makeEvent("e1", "run", 1), makeEvent("e2", "run", 2), makeEvent("e3", "run", 3)]);
      expect(result.ok).toBe(true);
      expect(result.eventCount).toBe(3);
    });

    it("accepts an empty stream", () => {
      expect(validateReplayStream([]).ok).toBe(true);
    });

    it("rejects a stream with a gap", () => {
      const result = validateReplayStream([makeEvent("e1", "run", 1), makeEvent("e3", "run", 3)]);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("gap");
    });

    it("rejects a stream with duplicate versions", () => {
      const result = validateReplayStream([makeEvent("e1", "run", 1), makeEvent("e1b", "run", 1)]);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("duplicate");
    });

    it("rejects a stream that does not start at version 1", () => {
      const result = validateReplayStream([makeEvent("e2", "run", 2)]);
      expect(result.ok).toBe(false);
    });
  });

  describe("hashReplayStream", () => {
    it("produces a stable deterministic hash regardless of input order", () => {
      const a = [makeEvent("e1", "run", 1), makeEvent("e2", "run", 2)];
      const b = [makeEvent("e2", "run", 2), makeEvent("e1", "run", 1)];
      expect(hashReplayStream(a)).toBe(hashReplayStream(b));
      expect(hashReplayStream(a)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("runReplay", () => {
    it("sources the stream from the event repository and completes", async () => {
      const replay = await repo.create(makeReplay("srv-1", "run-1"));
      eventRepo.events = [makeEvent("e1", "run-1", 1), makeEvent("e2", "run-1", 2)];

      const result = await service.runReplay(replay.id);
      expect(result.status).toBe("completed");
      expect(result.eventCount).toBe(2);
      expect(result.processedCount).toBe(2);
      const rr = result.result as Record<string, unknown>;
      expect(rr.streamSource).toBe("event-repository");
      expect(rr.eventIds).toEqual(["e1", "e2"]);
    });

    it("uses provided events over the repository and is repeatable", async () => {
      const events = [makeEvent("p1", "run-2", 1), makeEvent("p2", "run-2", 2)];
      const replay = await repo.create({ ...makeReplay("srv-2", "run-2"), events });
      eventRepo.events = [makeEvent("x", "run-2", 999)]; // must be ignored

      const first = await service.runReplay(replay.id);
      expect(first.status).toBe("completed");
      expect((first.result as Record<string, unknown>).eventIds).toEqual(["p1", "p2"]);

      // Deterministic repeat: same stream hash on a fresh run of the same input.
      const replay2 = await repo.create({ ...makeReplay("srv-2b", "run-2"), events });
      const second = await service.runReplay(replay2.id);
      expect((second.result as Record<string, unknown>).streamHash)
        .toBe((first.result as Record<string, unknown>).streamHash);
    });

    it("completes with zero events for an empty stream", async () => {
      const replay = await repo.create(makeReplay("srv-3", "run-3"));
      const result = await service.runReplay(replay.id);
      expect(result.status).toBe("completed");
      expect(result.eventCount).toBe(0);
    });

    it("fails the replay when no event source is available", async () => {
      const noSourceService = new ReplayService(repo, bus); // no eventRepo
      const replay = await repo.create(makeReplay("srv-4", "run-4"));
      const result = await noSourceService.runReplay(replay.id);
      expect(result.status).toBe("failed");
      expect(result.failedCount).toBe(1);
      expect(result.reason).toContain("REPLAY_STREAM_INVALID");
    });

    it("records a gap as a failed replay with reason", async () => {
      const events = [makeEvent("g1", "run-5", 1), makeEvent("g3", "run-5", 3)];
      const replay = await repo.create({ ...makeReplay("srv-5", "run-5"), events });

      const result = await service.runReplay(replay.id);
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("gap");
      const persisted = await repo.findById(replay.id);
      expect(persisted?.status).toBe("failed");
    });

    it("throws REPLAY_IN_PROGRESS for concurrent execution", async () => {
      const replay = await repo.create(makeReplay("srv-6", "run-6"));
      await repo.update(replay.id, { status: "in_progress" });

      let thrown: Error | undefined;
      try {
        await service.runReplay(replay.id);
      } catch (err: unknown) {
        thrown = err as Error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as OrchestrationError).code).toBe(ErrorCodes.REPLAY_IN_PROGRESS.code);
    });

    it("throws ENTITY_NOT_FOUND for unknown replay", async () => {
      let thrown: Error | undefined;
      try {
        await service.runReplay("missing");
      } catch (err: unknown) {
        thrown = err as Error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as OrchestrationError).code).toBe(ErrorCodes.ENTITY_NOT_FOUND.code);
    });

    it("publishes REPLAY_STARTED and REPLAY_COMPLETED", async () => {
      const published: string[] = [];
      bus.subscribeAll((e) => { published.push(e.type) });
      const replay = await repo.create(makeReplay("srv-7", "run-7"));
      eventRepo.events = [makeEvent("e1", "run-7", 1)];

      await service.runReplay(replay.id);
      expect(published).toContain("replay.started");
      expect(published).toContain("replay.completed");
    });

    it("publishes REPLAY_FAILED on stream validation failure", async () => {
      const published: string[] = [];
      bus.subscribeAll((e) => { published.push(e.type) });
      const replay = await repo.create(makeReplay("srv-8", "run-8"));
      eventRepo.events = [makeEvent("e1", "run-8", 1), makeEvent("e1b", "run-8", 1)];

      const result = await service.runReplay(replay.id);
      expect(result.status).toBe("failed");
      expect(published).toContain("replay.failed");
    });
  });

  describe("createReplay / getReplay / listReplays", () => {
    it("creates a pending replay and publishes REPLAY_CREATED", async () => {
      const published: string[] = [];
      bus.subscribeAll((e) => { published.push(e.type) });

      const replay = await service.createReplay({ sourceRunId: "run-c1", correlationId: "corr-c1" });
      expect(replay.status).toBe("pending");
      expect(replay.sourceRunId).toBe("run-c1");
      expect(published).toContain("replay.created");
    });

    it("getReplay throws ENTITY_NOT_FOUND for unknown id", async () => {
      let thrown: Error | undefined;
      try {
        await service.getReplay("missing");
      } catch (err: unknown) {
        thrown = err as Error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as OrchestrationError).code).toBe(ErrorCodes.ENTITY_NOT_FOUND.code);
    });

    it("lists replays", async () => {
      await service.createReplay({ sourceRunId: "run-l1", correlationId: "corr-l1" });
      await service.createReplay({ sourceRunId: "run-l2", correlationId: "corr-l2" });
      const result = await service.listReplays({ page: 1, limit: 10 });
      expect(result.total).toBe(2);
    });
  });
});
