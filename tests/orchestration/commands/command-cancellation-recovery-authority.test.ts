import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner"
import { createProductionOrchestrationRuntime } from "../../../src/orchestration/composition"

describe("M9 command cancellation authority", () => {
  it("cancels a command while the canonical scheduler is active and leaves no runnable plan", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const runtime = createProductionOrchestrationRuntime(db)
    let release!: () => void
    const schedulerGate = new Promise<void>(resolve => { release = resolve })
    const originalRunReady = runtime.executionScheduler.runReady.bind(runtime.executionScheduler)
    ;(runtime.executionScheduler as any).runReady = async (planId: string, executor: any) => {
      await schedulerGate
      return originalRunReady(planId, executor)
    }
    const executing = runtime.commands.executor.executeCommand("task/start", { taskDescription: "cancel authority" })
    for (let i = 0; i < 100; i++) {
      const row = db.query("SELECT invocation_id FROM command_invocations WHERE status = 'running'").get() as any
      if (row) {
        const cancelled = await runtime.commands.executor.cancelCommand(row.invocation_id, "test cancellation")
        expect(cancelled.error?.code).toBe("COMMAND_CANCELLED")
        break
      }
      await Promise.resolve()
    }
    release()
    const result = await executing
    expect(result.status).toBe("cancelled")
    const plan = db.query("SELECT status FROM execution_plans ORDER BY created_at DESC LIMIT 1").get() as any
    expect(plan.status).toBe("cancelled")
    expect((db.query("SELECT COUNT(*) AS c FROM execution_workstreams WHERE status IN ('planned','ready','running')").get() as any).c).toBe(0)
    db.close()
  })
})
