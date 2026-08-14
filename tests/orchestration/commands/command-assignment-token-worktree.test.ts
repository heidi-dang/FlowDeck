import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner"
import { createProductionOrchestrationRuntime } from "../../../src/orchestration/composition"
import { execFileSync } from "node:child_process"
import { OpenCodeWorkstreamExecutor } from "../../../src/orchestration/execution/opencode-executor"

describe("M9 command assignment/token/worktree authority", () => {
  it("routes command work through the canonical OpenCode executor seam", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const root = process.cwd()
    const worktreeRoot = mkdtempSync(`${tmpdir()}/flowdeck-m9-dispatch-`)
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    let prompts = 0
    const client = { session: {
      create: async () => ({ data: { id: "command-dispatch-session" } }),
      prompt: async () => { prompts += 1; return { data: { info: { id: "command-dispatch-result" } } } },
    } }
    const opencode = new OpenCodeWorkstreamExecutor(client, () => true)
    const runtime = createProductionOrchestrationRuntime(db, { repositoryPath: root, worktreeRoot, agentExecutor: { execute: (workstream: any, allocation: any, budget: any, context: any) => opencode.execute(workstream, allocation, budget, context) } })
    const result = await runtime.commands.executor.executeCommand("task/start", { taskDescription: "canonical dispatch", sourceSha, ownedPaths: ["src/orchestration/commands"] })
    expect(result.status).toBe("completed")
    expect(prompts).toBe(1)
    expect((db.query("SELECT COUNT(*) AS c FROM assignments WHERE run_id = ? AND status = 'completed'").get(result.taskRunId!) as any).c).toBe(1)
    db.close()
  })

  it("executes a command through assignments, canonical token budget, and isolated worktree leases", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const root = process.cwd()
    const worktreeRoot = mkdtempSync(`${tmpdir()}/flowdeck-m9-worktrees-`)
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    const runtime = createProductionOrchestrationRuntime(db, { repositoryPath: root, worktreeRoot, agentExecutor: new OpenCodeWorkstreamExecutor({ session: { create: async () => ({ data: { id: "happy-session" } }), prompt: async () => ({ data: { info: { id: "happy-result" } } }) } }, () => true) })
    const result = await runtime.commands.executor.executeCommand("task/start", { taskDescription: "assignment authority", sourceSha, ownedPaths: ["src/orchestration/commands"] })
    expect(result.status).toBe("completed")
    const runId = result.taskRunId!
    expect((db.query("SELECT COUNT(*) AS c FROM assignments WHERE run_id = ? AND status = 'completed'").get(runId) as any).c).toBe(1)
    expect((db.query("SELECT COUNT(*) AS c FROM execution_workstreams WHERE run_id = ? AND status = 'integrated'").get(runId!) as any).c).toBe(1)
    expect((db.query("SELECT COUNT(*) AS c FROM execution_ownership_claims WHERE run_id = ?").get(runId) as any).c).toBe(1)
    expect((db.query("SELECT COUNT(*) AS c FROM execution_worktree_leases WHERE run_id = ? AND state IN ('allocated','active','renewing')").get(runId) as any).c).toBe(0)
    const budget = runtime.tokenRuntime!.getRunSnapshot(runId) as any
    expect(budget.run.reserved).toBe(0)
    expect(budget.run.consumed).toBeGreaterThan(0)
    db.close()
  })

  it("persists canonical Assignment failure when the OpenCode boundary fails", async () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const root = process.cwd()
    const worktreeRoot = mkdtempSync(`${tmpdir()}/flowdeck-m9-dispatch-failure-`)
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    const agentExecutor = new OpenCodeWorkstreamExecutor({ session: { create: async () => ({ data: { id: "failed-session" } }), prompt: async () => { throw new Error("deterministic agent failure") } } }, () => true)
    const runtime = createProductionOrchestrationRuntime(db, { repositoryPath: root, worktreeRoot, agentExecutor })
    const result = await runtime.commands.executor.executeCommand("task/start", { taskDescription: "dispatch failure", sourceSha, ownedPaths: ["src/orchestration/commands"] })
    expect(result.status).toBe("failed")
    expect((db.query("SELECT COUNT(*) AS c FROM assignments WHERE status = 'failed'").get() as any).c).toBe(1)
    expect((db.query("SELECT COUNT(*) AS c FROM completion_decisions WHERE decision = 'pass'").get() as any).c).toBe(0)
    db.close()
  }, 15000)
})
