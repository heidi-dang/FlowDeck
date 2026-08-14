import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTransactionManager } from "../../../src/orchestration/persistence/transaction-manager";
import { CommandRegistry } from "../../../src/orchestration/commands/domain/command-registry";
import { SqliteCommandInvocationRepository } from "../../../src/orchestration/commands/persistence/sqlite-command-invocation-repository";
import { DurableCommandExecutor } from "../../../src/orchestration/commands/services/durable-command-executor";
import { CORE_M9_COMMANDS } from "../../../src/orchestration/commands/definitions/core-commands";
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner";

describe("M9 Command Concurrency & Idempotency", () => {
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
      executionRepository: { savePlan: (plan: any) => plan, transitionPlanStatus: () => {}, getDb: () => db },
      executionScheduler: { runReady: async () => ({ started: [], succeeded: ["primary"], failed: [], blocked: [] }) },
      services: {},
      commandVerification: { verifyCommand: async () => ({ passed: true, verificationResults: [], evidenceItems: [] }) },
      commandCompletion: { evaluateCommand: async () => ({ outcome: "completed", decisionId: "d1" }) },
      assignmentBindingCoordinator: { ensureAssignments: async () => new Map<string, string>(), recordAttempt: () => ({}), markSucceeded: () => ({}), markFailed: () => ({}), markCancelled: () => ({}), listByPlan: () => [] },
      recoveryClaim: { acquire: () => true, release: () => {} },
    } as any);
  });

  afterEach(() => {
    db.close();
  });

  it("handles 20 concurrent identical submissions with single logical run", async () => {
    const idempotencyKey = "ik-concurrent-1";
    const submissions = Array.from({ length: 20 }, () => 
      executor.executeCommand("task/start", { taskDescription: "build auth", verificationPassed: true }, { idempotencyKey })
    );
    
    const results = await Promise.all(submissions);
    
    // Check that we got 20 results successfully
    expect(results.length).toBe(20);
    
    // Extract unique invocation IDs
    const invocationIds = new Set(results.map(r => r.invocationId));
    expect(invocationIds.size).toBe(1);
    
    // Validate we persisted exactly 1 invocation
    const count = (db.query(`SELECT COUNT(*) as c FROM command_invocations WHERE idempotency_key = ?`).get(idempotencyKey) as any).c;
    expect(count).toBe(1);
  });
});
