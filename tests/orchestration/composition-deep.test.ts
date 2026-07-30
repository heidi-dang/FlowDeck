import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createProductionOrchestrationRuntime } from "../../src/orchestration/composition";
import { initializeDatabase } from "../../src/orchestration/persistence/database";
import { OrchestrationError, ErrorCodes } from "../../src/orchestration/types/errors";
import { deterministicCleanup } from "./harness/cleanup";
import type { ProductionOrchestrationRuntime } from "../../src/orchestration/composition";

describe("Production Composition Deep Integration", () => {
  let tempDir: string;
  let db: Database;
  let runtime: ProductionOrchestrationRuntime | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "comp-deep-test-"));
    const dbPath = join(tempDir, "test.db");
    const init = initializeDatabase({ path: dbPath });
    db = init.db;
  });

  afterEach(async () => {
    await deterministicCleanup({ db, dir: tempDir, outboxWorker: runtime?.outboxWorker, executionRegistry: runtime?.executionRegistry })
  });

  it("exercises all services registered in production composition runtime", async () => {
    runtime = createProductionOrchestrationRuntime(db);

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
    expect(run.status).toBe("pending");

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
      expect((err as OrchestrationError).code).toBe(ErrorCodes.REPLAY_NOT_CONFIGURED.code)
    }
  });

  it("completion update throws immutable error", async () => {
    runtime = createProductionOrchestrationRuntime(db);
    const run = await runtime.services.runService.createRun({
      runType: "test", sessionId: "s1", contractId: "contract-default", correlationId: "c-immutable",
    });
    const completion = await runtime.services.completionService.createCompletion({
      runId: run.id, correlationId: "c-immutable", summary: "test",
    });
    const completionRepo = (runtime.services.completionService as any).completionRepo;
    try {
      await completionRepo.update(completion.id, { summary: "updated" });
      expect(true).toBe(false);
    } catch (err: unknown) {
      expect((err as OrchestrationError).code).toBe(ErrorCodes.COMPLETION_DECISION_IMMUTABLE.code);
    }
  });

  it("verification update persists status changes", async () => {
    runtime = createProductionOrchestrationRuntime(db);
    const run = await runtime.services.runService.createRun({
      runType: "test", sessionId: "s1", contractId: "contract-default", correlationId: "c-ver-upd",
    });
    const v = await runtime.services.verificationService.createVerification({
      runId: run.id, checkType: "style", correlationId: "c-ver-upd",
    });
    const updated = await runtime.services.verificationService.updateVerification(v.id, { status: "passed" });
    expect(updated.status).toBe("passed");
  });

  it("verification findById returns null for missing", async () => {
    runtime = createProductionOrchestrationRuntime(db);
    const verRepo = (runtime.services.verificationService as any).verificationRepo;
    const found = await verRepo.findById("nonexistent");
    expect(found).toBeNull();
  });

  it("verification findMany and count work", async () => {
    runtime = createProductionOrchestrationRuntime(db);
    const run = await runtime.services.runService.createRun({
      runType: "test", sessionId: "s1", contractId: "contract-default", correlationId: "c-vm",
    });
    await runtime.services.verificationService.createVerification({
      runId: run.id, checkType: "audit", correlationId: "c-vm",
    });
    const verRepo = (runtime.services.verificationService as any).verificationRepo;
    const result = await verRepo.findMany({}, { page: 1, limit: 10 });
    expect(result.total).toBeGreaterThanOrEqual(1);
    const count = await verRepo.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("verification findByRunId returns results", async () => {
    runtime = createProductionOrchestrationRuntime(db);
    const run = await runtime.services.runService.createRun({
      runType: "test", sessionId: "s1", contractId: "contract-default", correlationId: "c-vrid",
    });
    await runtime.services.verificationService.createVerification({
      runId: run.id, checkType: "security", correlationId: "c-vrid",
    });
    const verRepo = (runtime.services.verificationService as any).verificationRepo;
    const results = await verRepo.findByRunId(run.id);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("event store and retrieve work through production repo", async () => {
    runtime = createProductionOrchestrationRuntime(db);
    const run = await runtime.services.runService.createRun({
      runType: "test", sessionId: "s1", contractId: "contract-default", correlationId: "c-ev",
    });
    const events = await runtime.services.eventService.listEvents({}, { page: 1, limit: 10 });
    expect(events.items.length).toBeGreaterThanOrEqual(1);
    const firstEvent = events.items[0];
    const eventRepo = (runtime.services.eventService as any).eventRepo;
    const found = await eventRepo.findById(firstEvent.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(firstEvent.id);

    const runEvents = await eventRepo.findByRunId(run.id);
    expect(runEvents.length).toBeGreaterThanOrEqual(1);
  });
});
