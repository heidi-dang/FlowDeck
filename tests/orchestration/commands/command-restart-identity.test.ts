import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner"
import { createProductionOrchestrationRuntime } from "../../../src/orchestration/composition"

describe("M9 command restart identity", () => {
  it("reconstructs terminal command state with fresh runtime objects without rerunning work", async () => {
    const directory = mkdtempSync(`${tmpdir()}/flowdeck-m9-restart-`)
    const dbPath = join(directory, "runtime.sqlite")
    const dbA = new Database(dbPath)
    runMigrations(dbA)
    const runtimeA = createProductionOrchestrationRuntime(dbA)
    const first = await runtimeA.commands.executor.executeCommand("task/start", { taskDescription: "restart identity" })
    expect(first.status).toBe("completed")
    const before = dbA.query("SELECT invocation_id,task_run_id,plan_id FROM command_invocations WHERE invocation_id = ?").get(first.invocationId) as any
    const countsBefore = dbA.query("SELECT (SELECT COUNT(*) FROM task_runs) AS runs, (SELECT COUNT(*) FROM execution_plans) AS plans, (SELECT COUNT(*) FROM assignments) AS assignments, (SELECT COUNT(*) FROM completion_decisions) AS decisions").get() as any
    dbA.close()

    const dbB = new Database(dbPath)
    runMigrations(dbB)
    const runtimeB = createProductionOrchestrationRuntime(dbB)
    const recovered = await runtimeB.commands.executor.recoverCommand(first.invocationId)
    expect(recovered.status).toBe("completed")
    expect(recovered.error).toBeUndefined()
    const after = dbB.query("SELECT invocation_id,task_run_id,plan_id FROM command_invocations WHERE invocation_id = ?").get(first.invocationId) as any
    const countsAfter = dbB.query("SELECT (SELECT COUNT(*) FROM task_runs) AS runs, (SELECT COUNT(*) FROM execution_plans) AS plans, (SELECT COUNT(*) FROM assignments) AS assignments, (SELECT COUNT(*) FROM completion_decisions) AS decisions").get() as any
    expect(after).toEqual(before)
    expect(after).toEqual({ invocation_id: first.invocationId, task_run_id: first.taskRunId, plan_id: `plan:${first.invocationId}` })
    expect(countsAfter).toEqual(countsBefore)
    dbB.close()
  })
})
