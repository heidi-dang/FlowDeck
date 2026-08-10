import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner"
import { createProductionOrchestrationRuntime } from "../../../src/orchestration/composition"

describe("M9 production command authority", () => {
  it("persists and projects the canonical run, plan, verification, evidence, and completion decision", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const runtime = createProductionOrchestrationRuntime(db)
    const result = await runtime.commands.executor.executeCommand("task/start", { taskDescription: "canonical authority proof" })
    expect(result.status).toBe("completed")
    expect(result.taskRunId).toBeDefined()
    const invocation = db.query("SELECT plan_id, task_run_id, status FROM command_invocations WHERE invocation_id = ?").get(result.invocationId) as any
    expect(invocation.status).toBe("completed")
    expect(invocation.plan_id).toBe(`plan:${result.invocationId}`)
    const runId = result.taskRunId!
    expect((db.query("SELECT COUNT(*) AS c FROM execution_plans WHERE plan_id = ?").get(invocation.plan_id as string) as any).c).toBe(1)
    expect((db.query("SELECT COUNT(*) AS c FROM verification_results WHERE run_id = ? AND status = 'passed'").get(runId) as any).c).toBeGreaterThan(0)
    expect((db.query("SELECT COUNT(*) AS c FROM evidence WHERE run_id = ?").get(runId) as any).c).toBeGreaterThan(0)
    expect((db.query("SELECT COUNT(*) AS c FROM completion_decisions WHERE run_id = ? AND decision = 'pass'").get(runId) as any).c).toBe(1)
    db.close()
  })
})
