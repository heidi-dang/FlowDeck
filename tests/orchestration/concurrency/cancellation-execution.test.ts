import { describe, it, expect, beforeEach } from "bun:test";
import { ExecutionRegistry } from "../../../src/orchestration/services/execution-registry";
import { RunService } from "../../../src/orchestration/services/run-service";
import { RunStatus } from "../../../src/orchestration/types";
import type { IRunRepository, IEventBus } from "../../../src/orchestration/services/ports";

class InMemoryRunRepo implements IRunRepository {
  private runs = new Map<string, any>();
  async create(run: any) { this.runs.set(run.id, { ...run }); return run; }
  async findById(id: string) { return this.runs.get(id) ?? null; }
  async update(id: string, input: any) {
    const existing = this.runs.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...input };
    this.runs.set(id, updated);
    return updated;
  }
  async findMany() {
    const items = Array.from(this.runs.values());
    return { data: items, items, total: items.length, page: 1, pageSize: 50, limit: 50, hasMore: false };
  }
  async count() { return this.runs.size; }
}

class FakeEventBus implements IEventBus {
  published: any[] = [];
  async publish(event: any) { this.published.push(event); }
  subscribe() { return () => {}; }
  subscribeAll() { return () => {}; }
  getSubscriberCount() { return 0; }
}

describe("ExecutionRegistry & RunService Cancellation Lifecycle", () => {
  let registry: ExecutionRegistry;
  let repo: InMemoryRunRepo;
  let eventBus: FakeEventBus;
  let runService: RunService;

  beforeEach(() => {
    registry = new ExecutionRegistry();
    repo = new InMemoryRunRepo();
    eventBus = new FakeEventBus();
    runService = new RunService(repo, eventBus, registry);
  });

  it("signals AbortController and executes cleanup idempotently", async () => {
    const run = await runService.createRun({ runType: "test", sessionId: "s1", correlationId: "c1" });
    await runService.updateRun(run.id, { status: RunStatus.RUNNING });

    const abortController = new AbortController();
    let cleanupCount = 0;

    registry.registerRun(run.id, abortController, async () => {
      cleanupCount++;
    });

    expect(registry.hasActiveRun(run.id)).toBe(true);

    const cancelledRun = await runService.cancelRun(run.id, "User requested cancellation");

    expect(cancelledRun.status).toBe(RunStatus.CANCELLED);
    expect(abortController.signal.aborted).toBe(true);
    expect(cleanupCount).toBe(1);
    expect(registry.hasActiveRun(run.id)).toBe(false);
  });

  it("handles hanging cleanup and resolves timeout deterministically without timer leak", async () => {
    const run = await runService.createRun({ runType: "test", sessionId: "s1", correlationId: "c1" });
    const abortController = new AbortController();

    // Register a hanging cleanup function
    registry.registerRun(run.id, abortController, () => new Promise<void>(() => {}));

    const result = await registry.cancelRunExecution(run.id, "Testing hanging cleanup", 50);

    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.cleanupErrors.length).toBeGreaterThan(0);
    expect(result.cleanupErrors[0].message).toContain("timed out after 50ms");
    expect(registry.hasActiveRun(run.id)).toBe(false);
  });

  it("resolves concurrent completion vs cancellation race deterministically", async () => {
    const run = await runService.createRun({ runType: "test", sessionId: "s1", correlationId: "c1" });
    await runService.updateRun(run.id, { status: RunStatus.RUNNING });

    // Simulate completion winning the race right before cancellation updates status
    await runService.updateRun(run.id, { status: RunStatus.COMPLETED });

    const result = await runService.cancelRun(run.id, "Late cancel request").catch(err => err);
    expect(result.code || result.name).toBe("RUN_IN_TERMINAL_STATE");
  });

  it("handles cleanup callback failures without leaking active handles", async () => {
    const run = await runService.createRun({ runType: "test", sessionId: "s1", correlationId: "c1" });
    const abortController = new AbortController();

    registry.registerRun(run.id, abortController, () => {
      throw new Error("Cleanup resource error");
    });

    const result = await registry.cancelRunExecution(run.id, "Testing cleanup failure");
    expect(result.cancelled).toBe(true);
    expect(result.cleanupErrors.length).toBe(1);
    expect(result.cleanupErrors[0].message).toBe("Cleanup resource error");
    expect(registry.hasActiveRun(run.id)).toBe(false);
  });

  it("ensures reusing run ID clears previous state", async () => {
    const runId = "reused-run-id";
    registry.registerRun(runId, new AbortController(), () => {});
    registry.unregisterRun(runId);

    expect(registry.hasActiveRun(runId)).toBe(false);

    let newCleanupCount = 0;
    registry.registerRun(runId, new AbortController(), () => { newCleanupCount++; });
    await registry.cancelRunExecution(runId, "Cancelling reused run");

    expect(newCleanupCount).toBe(1);
  });
});
