import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTransactionManager } from "../../../src/orchestration/persistence/transaction-manager";
import { CommandRegistry } from "../../../src/orchestration/commands/domain/command-registry";
import { SqliteCommandInvocationRepository } from "../../../src/orchestration/commands/persistence/sqlite-command-invocation-repository";
import { DurableCommandExecutor } from "../../../src/orchestration/commands/services/durable-command-executor";
import { CORE_M9_COMMANDS } from "../../../src/orchestration/commands/definitions/core-commands";
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner";

describe("M9 Durable Command Executor", () => {
  let db: Database;
  let registry: CommandRegistry;
  let repo: SqliteCommandInvocationRepository;
  let executor: DurableCommandExecutor;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    const tx = createTransactionManager(db);
    repo = new SqliteCommandInvocationRepository(db, tx);

    registry = new CommandRegistry();
    CORE_M9_COMMANDS.forEach(c => registry.register(c));

    executor = new DurableCommandExecutor(registry, repo, {
      executionRepository: { savePlan: (plan: any) => plan, transitionPlanStatus: () => {}, getDb: () => db, getPlan: () => ({ planId: "mock", runId: "mock", workstreams: [] }) },
      executionScheduler: { runReady: async () => ({ started: [], succeeded: ["primary"], failed: [], blocked: [] }) },
      services: {},
      commandVerification: { verifyCommand: async () => ({ passed: true, verificationResults: [], evidenceItems: [] }) },
      commandCompletion: { evaluateCommand: async () => ({ outcome: "completed", decisionId: "d1" }) },
      assignmentBindingCoordinator: { ensureAssignments: async () => new Map<string, string>(), recordAttempt: () => ({}), markSucceeded: () => ({}), markFailed: () => ({}), markCancelled: () => ({}), listByPlan: () => [] },
      recoveryClaim: { claimExclusiveExecution: async () => true, releaseClaim: async () => {}, acquire: () => true, release: () => {} },
    } as any);
  });

  afterEach(() => {
    db.close();
  });

  it("executes a core command durably", async () => {
    const result = await executor.executeCommand("task/start", { taskDescription: "Start!" }, { idempotencyKey: "test-sha" });
    expect(result.status).toBe("completed");

    await repo.getByIdempotencyKey(`${(result as any).invocationId}`); // wait, if idempotency key is test-sha
  });

  it("enforces idempotency", async () => {
    const idempotencyKey = "ik-test-123";
    await executor.executeCommand("fd-task", { taskDescription: "A" }, { idempotencyKey });

    const res2 = await executor.executeCommand("fd-task", { taskDescription: "B" }, { idempotencyKey });

    expect(res2.status).toBe("failed");
    expect(res2.error?.code).toBe("COMMAND_IDEMPOTENCY_CONFLICT");
  });
});
