import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createProductionOrchestrationRuntime } from "../../src/orchestration/composition";
import { initializeDatabase } from "../../src/orchestration/persistence/database";
import { RunStatus } from "../../src/orchestration/types";

describe("Production Composition Wiring & Integration", () => {
  let tempDir: string;
  let db: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "comp-wiring-test-"));
    const dbPath = join(tempDir, "test.db");
    const init = initializeDatabase({ path: dbPath });
    db = init.db;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("instantiates production composition root with shared ExecutionRegistry and UnitOfWork", async () => {
    const runtime = createProductionOrchestrationRuntime(db);

    expect(runtime.executionRegistry).toBeDefined();
    expect(runtime.unitOfWork).toBeDefined();
    expect(runtime.outboxWorker).toBeDefined();
    expect(runtime.router).toBeDefined();

    // Create a run via production service
    const run = await runtime.services.runService.createRun({
      runType: "production-test",
      sessionId: "sess-123",
      correlationId: "corr-123",
    });

    expect(run.id).toBeDefined();
    expect(run.status).toBe(RunStatus.QUEUED);

    // Register active execution on the shared registry
    const abortController = new AbortController();
    let cleanupCalled = false;

    runtime.executionRegistry.registerRun(run.id, abortController, () => {
      cleanupCalled = true;
    });

    expect(runtime.executionRegistry.hasActiveRun(run.id)).toBe(true);

    // Cancel run via production run service
    const cancelled = await runtime.services.runService.cancelRun(run.id, "Testing composition cancellation");

    expect(cancelled.status).toBe(RunStatus.CANCELLED);
    expect(abortController.signal.aborted).toBe(true);
    expect(cleanupCalled).toBe(true);
    expect(runtime.executionRegistry.hasActiveRun(run.id)).toBe(false);
  });
});
