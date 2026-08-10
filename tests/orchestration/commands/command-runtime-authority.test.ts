import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner"
import { createTransactionManager } from "../../../src/orchestration/persistence/transaction-manager"
import { CommandRegistry } from "../../../src/orchestration/commands/domain/command-registry"
import { CORE_M9_COMMANDS } from "../../../src/orchestration/commands/definitions/core-commands"
import { SqliteCommandInvocationRepository } from "../../../src/orchestration/commands/persistence/sqlite-command-invocation-repository"
import { DurableCommandExecutor } from "../../../src/orchestration/commands/services/durable-command-executor"

describe("M9 command authority integration", () => {
  it("persists a canonical execution plan and does not complete before canonical verification", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const registry = new CommandRegistry()
    CORE_M9_COMMANDS.forEach(command => registry.register(command))
    const repo = new SqliteCommandInvocationRepository(db, createTransactionManager(db))
    const runtime = {
      executionRepository: { savePlan: (plan: any) => plan },
      executionScheduler: { runReady: async () => ({ started: [], succeeded: ["primary"], failed: [], blocked: [] }) },
      services: {
        verificationService: { createVerification: async () => { throw new Error("canonical verifier required") } },
        completionService: { createCompletion: async () => { throw new Error("canonical completion required") } },
      },
    } as any
    const executor = new DurableCommandExecutor(registry, repo, runtime)
    const result = await executor.executeCommand("execute", { taskRunId: "run-authority", sourceSha: "0".repeat(40) }, { idempotencyKey: "authority-test" })
    expect(result.status).toBe("failed")
    expect(result.error?.message).toContain("CANONICAL")
    db.close()
  })
})
