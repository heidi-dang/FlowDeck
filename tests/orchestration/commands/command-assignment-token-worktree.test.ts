import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner"
import { createProductionOrchestrationRuntime } from "../../../src/orchestration/composition"
import { execFileSync } from "node:child_process"

describe("M9 command assignment/token/worktree authority", () => {
  it("executes a command through assignments, canonical token budget, and isolated worktree leases", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const root = process.cwd()
    const worktreeRoot = mkdtempSync(`${tmpdir()}/flowdeck-m9-worktrees-`)
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    const runtime = createProductionOrchestrationRuntime(db, { repositoryPath: root, worktreeRoot })
    const result = await runtime.commands.executor.executeCommand("task/start", { taskDescription: "assignment authority", sourceSha, ownedPaths: ["src/orchestration/commands"] })
    expect(result.status).toBe("completed")
    const runId = result.taskRunId!
    expect((db.query("SELECT COUNT(*) AS c FROM assignments WHERE run_id = ? AND status = 'completed'").get(runId) as any).c).toBe(1)
    expect((db.query("SELECT COUNT(*) AS c FROM execution_workstreams WHERE run_id = ? AND status = 'integrated'").get(runId) as any).c).toBe(1)
    expect((db.query("SELECT COUNT(*) AS c FROM execution_ownership_claims WHERE run_id = ?").get(runId) as any).c).toBe(1)
    expect((db.query("SELECT COUNT(*) AS c FROM execution_worktree_leases WHERE run_id = ? AND state IN ('allocated','active','renewing')").get(runId) as any).c).toBe(0)
    const budget = runtime.tokenRuntime!.getRunSnapshot(runId) as any
    expect(budget.run.reserved).toBe(0)
    expect(budget.run.consumed).toBe(0)
    db.close()
  })
})
