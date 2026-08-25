import { describe, it, expect, beforeEach, vi } from "bun:test";
import { ExecutionRegistry } from "../../../src/orchestration/services/execution-registry";
import { RunService } from "../../../src/orchestration/services/run-service";
import { RunStatus, ErrorCodes, OrchestrationError } from "../../../src/orchestration/types";
import type { IRunRepository, IEventBus, PaginatedResult } from "../../../src/orchestration/services/ports";
import type { UnitOfWork } from "../../../src/orchestration/persistence/unit-of-work";
import type { TransactionalRunWriter } from "../../../src/orchestration/persistence/transactional-run-writer";
import type { Database } from "bun:sqlite";
import type { Run, UpdateRunInput, RunFilter } from "../../../src/orchestration/types/runs";
import type { PagePaginationRequest } from "../../../src/orchestration/types/pagination";

class InMemoryRunRepo implements IRunRepository {
  private runs = new Map<string, Run>();

  async create(run: Run): Promise<Run> { this.runs.set(run.id, { ...run, updatedAt: new Date().toISOString() }); return run; }

  async findById(id: string): Promise<Run | null> { return this.runs.get(id) ?? null; }
  async findByCorrelationId(correlationId: string): Promise<Run | null> {
    for (const run of this.runs.values()) {
      if (run.correlationId === correlationId) return run;
    }
    return null;
  }

  async update(id: string, input: UpdateRunInput): Promise<Run | null> {
    const existing = this.runs.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...input, updatedAt: new Date().toISOString() } as Run;
    this.runs.set(id, updated);
    return updated;
  }

  async findMany(_filter: RunFilter, _pagination: PagePaginationRequest): Promise<PaginatedResult<Run>> {
    const items = Array.from(this.runs.values());
    return { items, total: items.length, page: 1, limit: 20 };
  }

  async count(_filter: RunFilter): Promise<number> { return this.runs.size; }
}

class FakeEventBus implements IEventBus {
  published: unknown[] = [];
  async publish(event: unknown): Promise<void> { this.published.push(event); }
  subscribe(): () => void { return () => {}; }
  subscribeAll(): () => void { return () => {}; }
  getSubscriberCount(): number { return 0; }
}

describe("Cancellation edge cases", () => {
  let registry: ExecutionRegistry;
  let repo: InMemoryRunRepo;
  let eventBus: FakeEventBus;
  let runService: RunService;
  let mockUnitOfWork: UnitOfWork;

  beforeEach(() => {
    registry = new ExecutionRegistry();
    repo = new InMemoryRunRepo();
    eventBus = new FakeEventBus();
    mockUnitOfWork = {
      execute: vi.fn(async (fn: any) => fn({ tx: {} as any })),
    };

    const mockWriter: TransactionalRunWriter = {
      createRunWithEventAndOutbox: vi.fn((_tx, _db, run) => { repo.create(run); return run; }),
      updateRunState: vi.fn((_tx, _db, _id, _input, _event, _outbox) => { repo.update(_id, _input); return { id: _id, status: _input.status ?? "unknown", runType: "test", correlationId: _id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as Run; }),
    };
    const mockDb = {} as Database;
    runService = new RunService(repo, eventBus, registry, mockUnitOfWork, mockWriter, mockDb);
  });

  it("hanging cleanup reaches timeout", async () => {
    const runId = "hang-test-run";
    const abortController = new AbortController();

    // Register with a hanging cleanup
    registry.registerRun(runId, abortController, () => {
      return new Promise<void>(() => { /* never resolves */ });
    });
    // Resolve execution so cancelRunExecution proceeds past the execution wait
    registry.resolveExecution(runId);

    const result = await registry.cancelRunExecution(runId, "test hanging cleanup", 100);

    // Execution was resolved, so cancelled should be true, but cleanup timed out
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.cleanupErrors.length).toBeGreaterThan(0);

    const timeoutError = result.cleanupErrors[0];
    expect(timeoutError.message).toContain("timed out");
    expect(timeoutError.message).toContain(runId);
  });

  it("timeout timer does not leak when cleanup resolves quickly", async () => {
    const runId = "no-leak-run";
    const abortController = new AbortController();
    let cleanupCalled = false;

    registry.registerRun(runId, abortController, async () => {
      cleanupCalled = true;
    });
    registry.resolveExecution(runId);

    const start = performance.now();
    const result = await registry.cancelRunExecution(runId, "fast cleanup", 5000);
    const elapsed = performance.now() - start;

    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.cleanupErrors.length).toBe(0);
    expect(cleanupCalled).toBe(true);

    // If the timeout timer was properly cleared, the call returns well before 5000 ms.
    expect(elapsed).toBeLessThan(1000);
  });

  it("completion and cancellation start concurrently via controlled barriers", async () => {
    const run = await runService.createRun({ runType: "concurrent", sessionId: "s1", correlationId: "c1" });
    await runService.updateRun(run.id, { status: RunStatus.RUNNING });

    const abortController = new AbortController();
    let cleanupCount = 0;
    registry.registerRun(run.id, abortController, async () => { cleanupCount++; });
    registry.resolveExecution(run.id);

    let gateResolve: () => void;
    const gate = new Promise<void>((resolve) => { gateResolve = resolve; });

    const cancelP = (async () => { await gate; return runService.cancelRun(run.id, "concurrent cancel"); })();
    const completeP = (async () => { await gate; return runService.updateRun(run.id, { status: RunStatus.COMPLETED }); })();

    gateResolve!();

    const [cancelResult, completeResult] = await Promise.allSettled([cancelP, completeP]);

    const terminalStatuses: string[] = [RunStatus.COMPLETED, RunStatus.CANCELLED];

    if (cancelResult.status === "fulfilled") {
      expect(terminalStatuses).toContain(cancelResult.value.status);
    } else {
      const err = cancelResult.reason;
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe(ErrorCodes.RUN_IN_TERMINAL_STATE.code);
    }

    if (completeResult.status === "fulfilled") {
      expect(terminalStatuses).toContain(completeResult.value.status);
    } else {
      const err = completeResult.reason;
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe(ErrorCodes.RUN_IN_TERMINAL_STATE.code);
    }

    const finalRun = await runService.getRun(run.id);
    expect(terminalStatuses).toContain(finalRun.status);

    // Cleanup must have been called at most once
    expect(cleanupCount).toBeLessThanOrEqual(1);
  });

  it("late completion cannot overwrite cancellation", async () => {
    const run = await runService.createRun({ runType: "late-complete", sessionId: "s2", correlationId: "c2" });
    await runService.updateRun(run.id, { status: RunStatus.RUNNING });

    const abortController = new AbortController();
    registry.registerRun(run.id, abortController, async () => {});
    registry.resolveExecution(run.id);

    // Cancel first
    const cancelled = await runService.cancelRun(run.id, "cancel before completion");
    expect(cancelled.status).toBe(RunStatus.CANCELLED);

    // Trying to complete a cancelled run must throw
    const err = await runService.updateRun(run.id, { status: RunStatus.COMPLETED }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestrationError);
    expect((err as OrchestrationError).code).toBe(ErrorCodes.RUN_IN_TERMINAL_STATE.code);
    expect((err as OrchestrationError).message).toContain("terminal state");
  });

  it("repeated cancellation is idempotent (registry-level)", async () => {
    const runId = "cancel-twice-run";
    const abortController = new AbortController();
    let cleanupCount = 0;

    registry.registerRun(runId, abortController, async () => { cleanupCount++; });
    registry.resolveExecution(runId);

    // First cancelRunExecution — handle exists, cleanup runs
    const first = await registry.cancelRunExecution(runId, "first cancel");
    expect(first.cancelled).toBe(true);
    expect(first.cleanupErrors.length).toBe(0);
    expect(first.timedOut).toBe(false);
    expect(cleanupCount).toBe(1);

    // Second cancelRunExecution — handle is already gone, returns no-op
    const second = await registry.cancelRunExecution(runId, "second cancel");
    expect(second.cancelled).toBe(false);
    expect(second.cleanupErrors.length).toBe(0);
    expect(second.timedOut).toBe(false);
    expect(registry.hasActiveRun(runId)).toBe(false);

    // Cleanup must not be called twice
    expect(cleanupCount).toBe(1);
  });
});