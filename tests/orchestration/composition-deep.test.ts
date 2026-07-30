import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createProductionOrchestrationRuntime } from "../../src/orchestration/composition";
import { initializeDatabase } from "../../src/orchestration/persistence/database";
import { OrchestrationError, ErrorCodes } from "../../src/orchestration/types/errors";

describe("Production Composition Deep Integration", () => {
  let tempDir: string;
  let db: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "comp-deep-test-"));
    const dbPath = join(tempDir, "test.db");
    const init = initializeDatabase({ path: dbPath });
    db = init.db;
  });

  afterEach(() => {
    try {
      db.exec("PRAGMA wal_checkpoint(FULL)")
    } catch {}
    try {
      db.close();
    } catch {}
    // On Windows, WAL/SHM files may still be locked briefly after close
    try {
      const walFile = join(tempDir, "test.db-wal")
      const shmFile = join(tempDir, "test.db-shm")
      try { rmSync(walFile, { force: true }) } catch {}
      try { rmSync(shmFile, { force: true }) } catch {}
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("exercises all services registered in production composition runtime", async () => {
    const runtime = createProductionOrchestrationRuntime(db);

    // Health service
    const health = await runtime.services.healthService.checkHealth();
    expect(health.status).toBe("healthy");

    // Contract service
    const contract = await runtime.services.contractService.createContract({
      name: "Test Contract",
      correlationId: "test-corr",
      description: "Desc",
      version: "1",
    });
    expect(contract.id).toBeDefined();

    // Run service
    const run = await runtime.services.runService.createRun({
      runType: "test",
      sessionId: "s1",
      contractId: contract.id,
      correlationId: "test-corr",
    });
    expect(run.id).toBeDefined();

    // Assignment service
    const assignment = await runtime.services.assignmentService.createAssignment({
      runId: run.id,
      agentId: "agent-1",
      role: "coder",
      correlationId: "test-corr",
    });
    expect(assignment.id).toBeDefined();

    // Verification service
    const verification = await runtime.services.verificationService.createVerification({
      runId: run.id,
      checkType: "lint",
      correlationId: "corr-1",
    });
    expect(verification.id).toBeDefined();

    // Completion service
    const completion = await runtime.services.completionService.createCompletion({
      runId: run.id,
      correlationId: "corr-1",
      summary: "Completed successfully",
    });
    expect(completion.id).toBeDefined();

    // Event service
    const events = await runtime.services.eventService.listEvents({}, { page: 1, limit: 10 });
    expect(events.items.length).toBeGreaterThanOrEqual(0);

    // Replay service (not configured in production — expect REPLAY_NOT_CONFIGURED)
    try {
      await runtime.services.replayService.createReplay({
        sourceRunId: run.id,
        correlationId: "corr-1",
      });
      expect(true).toBe(false);
    } catch (err: unknown) {
      expect(err as OrchestrationError).toMatchObject({ code: ErrorCodes.REPLAY_NOT_CONFIGURED });
    }
  });
});