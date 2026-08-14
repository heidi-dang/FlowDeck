import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTransactionManager } from "../../../src/orchestration/persistence/transaction-manager";
import { SqliteCommandInvocationRepository } from "../../../src/orchestration/commands/persistence/sqlite-command-invocation-repository";
import type { CommandInvocation } from "../../../src/orchestration/commands/domain/command-definition";
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner";

describe("M9 Command Invocation Persistence", () => {
  let db: Database;
  let repo: SqliteCommandInvocationRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    const tx = createTransactionManager(db);
    repo = new SqliteCommandInvocationRepository(db, tx);
  });

  afterEach(() => {
    db.close();
  });

  it("saves and retrieves a command invocation", async () => {
    const invocation: CommandInvocation = {
      invocationId: "inv-123",
      commandId: "task/start",
      commandVersion: 1,
      idempotencyKey: "ik-task-start-1",
      status: "running",
      input: { taskDescription: "Test command" },
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await repo.saveInvocation(invocation);

    const retrieved = await repo.getByIdempotencyKey("ik-task-start-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.invocationId).toBe("inv-123");
    expect(retrieved!.commandId).toBe("task/start");
    expect(retrieved!.status).toBe("running");
    expect(retrieved!.input).toEqual({ taskDescription: "Test command" });
  });

  it("updates an existing invocation on conflict", async () => {
    const invocation: CommandInvocation = {
      invocationId: "inv-456",
      commandId: "task/start",
      commandVersion: 1,
      idempotencyKey: "ik-task-start-2",
      status: "running",
      input: { taskDescription: "Original" },
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await repo.saveInvocation(invocation);

    const completedInvocation: CommandInvocation = {
      ...invocation,
      status: "completed",
      completedAt: new Date().toISOString(),
    };

    await repo.saveInvocation(completedInvocation);

    const retrieved = await repo.getByIdempotencyKey("ik-task-start-2");
    expect(retrieved!.status).toBe("completed");
    expect(retrieved!.completedAt).not.toBeUndefined();
  });

  it("rejects incompatible reuse of an idempotency key", async () => {
    const first: CommandInvocation = {
      invocationId: "inv-first", commandId: "task/start", commandVersion: 1,
      idempotencyKey: "ik-incompatible", status: "pending", input: { taskDescription: "one" },
      retryCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await repo.saveInvocation(first);
    await expect(repo.saveInvocation({ ...first, invocationId: "inv-second", input: { taskDescription: "two" } })).rejects.toThrow("incompatible")
  });
});
