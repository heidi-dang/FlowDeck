import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTransactionManager } from "../../../src/orchestration/persistence/transaction-manager";
import { CommandRegistry } from "../../../src/orchestration/commands/domain/command-registry";
import { SqliteCommandInvocationRepository } from "../../../src/orchestration/commands/persistence/sqlite-command-invocation-repository";
import { DurableCommandExecutor } from "../../../src/orchestration/commands/services/durable-command-executor";
import { CORE_M9_COMMANDS } from "../../../src/orchestration/commands/definitions/core-commands";
import { SCHEMA_V_0_2_6 } from "../../../src/orchestration/persistence/migrations/schema-embed";

describe("M9 Recovery & Cancellation", () => {
  let db: Database;
  let registry: CommandRegistry;
  let repo: SqliteCommandInvocationRepository;
  let executor: DurableCommandExecutor;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SCHEMA_V_0_2_6);
    const tx = createTransactionManager(db);
    repo = new SqliteCommandInvocationRepository(db, tx);
    
    registry = new CommandRegistry();
    CORE_M9_COMMANDS.forEach(c => registry.register(c));
    
    executor = new DurableCommandExecutor(registry, repo, {} as any);
  });

  afterEach(() => {
    db.close();
  });

  it("reconstructs state after process restart simulation", async () => {
    const idempotencyKey = "ik-recovery-test";
    
    // Simulate initial attempt
    await repo.saveInvocation({
      invocationId: "inv-crash-1",
      commandId: "task/start",
      commandVersion: 1,
      idempotencyKey,
      status: "running",
      input: { taskDescription: "Interrupted task" },
      taskRunId: "run-crash-1",
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Simulate process restart with new repo instance over same SQLite DB
    const tx2 = createTransactionManager(db);
    const repo2 = new SqliteCommandInvocationRepository(db, tx2);
    const executor2 = new DurableCommandExecutor(registry, repo2, {} as any);

    const result = await executor2.executeCommand("task/start", { taskDescription: "Interrupted task" }, { idempotencyKey });
    
    expect(result.status).toBe("running"); // Idempotent hit on existing running state
    expect(result.invocationId).toBe("inv-crash-1");
    expect(result.taskRunId).toBe("run-crash-1");
  });
});
