import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { runMigrations } from "../../src/orchestration/persistence/migrations/migration-runner"
import { createTransactionManager } from "../../src/orchestration/persistence/transaction-manager"
import { SqliteExecutionRepository, ExecutionScheduler, WorktreeExecutionService, GitWorktreeManager, ControlledIntegrationService, type ExecutionPlan } from "../../src/orchestration/execution"
import { SqlitePerformanceRepository } from "../../src/orchestration/performance"
import type { WorktreeAllocation } from "../../src/orchestration/execution/worktree-manager"

describe("worktree execution production chain", () => {
  let db: Database
  let repo: SqliteExecutionRepository
  beforeEach(() => {
    db = new Database(":memory:"); runMigrations(db)
    db.query("INSERT INTO contract_families VALUES ('f','f',NULL,'test',datetime('now'))").run()
    db.query("INSERT INTO task_contracts(contract_id,family_id,version,title,description,repo_url,repo_sha,created_by,created_at) VALUES ('c','f',1,'c','c','https://example.test','0123456789abcdef0123456789abcdef01234567','test',datetime('now'))").run()
    db.query("INSERT INTO task_runs(run_id,contract_id,strategy,state,baseline_sha,repo_branch,created_at,created_ts) VALUES ('run','c','planned','planning','0123456789abcdef0123456789abcdef01234567','main',datetime('now'),strftime('%s','now'))").run()
    repo = new SqliteExecutionRepository(db, createTransactionManager(db))
  })
  afterEach(() => db.close())

  it("dispatches isolated work and routes successful output through controlled integration", async () => {
    const plan: ExecutionPlan = { planId: "p", runId: "run", routingDecisionId: "d", sourceSha: "0123456789abcdef0123456789abcdef01234567", policyVersion: "2.0.0", createdAt: "2026-08-09T00:00:00.000Z", workstreams: [{ workstreamId: "a", runId: "run", planId: "p", resolvedAgent: "backend-coder", requiredCapability: "backend", objective: "implement", requirements: ["r"], acceptanceCriteria: ["a"], ownedPaths: ["src/a.ts"], ownedSymbols: [], dependsOn: [], strategy: "direct", budgetProfile: "normal", contextScope: "owned", status: "planned", blockedBy: [], createdAt: "2026-08-09T00:00:00.000Z" }] }
    repo.savePlan(plan)
    const allocation: WorktreeAllocation = { worktreeId: "wt-a", workspace: "/tmp/wt-a", branch: "flowdeck/wt-a", sourceSha: plan.sourceSha }
    const calls: string[] = []
    const worktrees = { allocate: () => allocation, assertOwnedPath: () => "/tmp/wt-a/src/a.ts", remove: () => { calls.push("remove") } }
    const integration = { integrate: (workstream: { workstreamId: string }) => { calls.push(`integrate:${workstream.workstreamId}`) } }
    const budget = { profile: "normal" as const, reserve: async () => ({ allowed: true, reservationId: "r", remainingRun: 100, claimed: 1 }), reconcile: async () => ({ committed: true, reclaimed: 0, remainingRun: 100 }), terminate: async () => {} }
    const budgetCoordinator = { open: () => { calls.push("budget"); return budget } }
    const service = new WorktreeExecutionService(repo, new ExecutionScheduler(repo), worktrees as never, integration as never, budgetCoordinator as never)
    const result = await service.executePlan("p", plan.sourceSha, { execute: async (_workstream, _allocation, workstreamBudget) => { expect(workstreamBudget?.profile).toBe("normal"); return { status: "succeeded", verificationPassed: true, integrationPassed: true } } })
    expect(result.succeeded).toEqual(["a"])
    expect(calls).toEqual(["budget", "integrate:a", "remove"])
  })

  it("executes a real writer in an isolated worktree and integrates exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "flowdeck-execution-"))
    const repository = join(root, "repo"); const worktreeRoot = join(root, "worktrees")
    mkdirSync(repository); execFileSync("git", ["init", "-q"], { cwd: repository }); execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repository }); execFileSync("git", ["config", "user.name", "test"], { cwd: repository })
    writeFileSync(join(repository, "README.md"), "base\n"); execFileSync("git", ["add", "README.md"], { cwd: repository }); execFileSync("git", ["commit", "-qm", "base"], { cwd: repository })
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim()
    const plan: ExecutionPlan = { planId: "real-plan", runId: "run", routingDecisionId: "d", sourceSha, policyVersion: "2.0.0", createdAt: "2026-08-09T00:00:00.000Z", workstreams: [{ workstreamId: "writer", runId: "run", planId: "real-plan", resolvedAgent: "backend-coder", requiredCapability: "backend", objective: "write", requirements: ["r"], acceptanceCriteria: ["a"], ownedPaths: ["src/**"], ownedSymbols: [], dependsOn: [], strategy: "direct", budgetProfile: "normal", contextScope: "owned", status: "planned", blockedBy: [], createdAt: "2026-08-09T00:00:00.000Z" }] }
    repo.savePlan(plan)
    const manager = new GitWorktreeManager(repository, worktreeRoot)
    const integration = new ControlledIntegrationService(repo, manager, repository)
    const performance = new SqlitePerformanceRepository(db, createTransactionManager(db))
    const service = new WorktreeExecutionService(repo, new ExecutionScheduler(repo), manager, integration, undefined, performance)
    const result = await service.executePlan("real-plan", sourceSha, { execute: async (_workstream, allocation) => { mkdirSync(join(allocation.workspace, "src")); writeFileSync(join(allocation.workspace, "src", "created.ts"), "export const created = true\n"); execFileSync("git", ["add", "src/created.ts"], { cwd: allocation.workspace }); execFileSync("git", ["commit", "-qm", "writer"], { cwd: allocation.workspace }); return { status: "succeeded", verificationPassed: true, integrationPassed: true, tokenReserved: 100, tokenUsed: 20, retryCount: 1, usefulnessSignals: ["artifact", "verification"] } } })
    expect(result).toEqual({ succeeded: ["writer"], failed: [], blocked: [] })
    expect(readFileSync(join(repository, "src", "created.ts"), "utf8")).toContain("created = true")
    expect(repo.getPlan("real-plan")!.workstreams[0].status).toBe("integrated")
    expect(repo.getPlan("real-plan")!.status).toBe("succeeded")
    expect(repo.listLeases("run").every(lease => lease.state === "released")).toBe(true)
    expect(performance.getObservation("perf:run:writer")?.tokenUsed).toBe(20)
    expect(performance.getObservation("perf:run:writer")?.integrationPassed).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it("rejects dispatch against a source SHA different from the persisted plan", async () => {
    const plan: ExecutionPlan = { planId: "sha-plan", runId: "run", routingDecisionId: "d", sourceSha: "0123456789abcdef0123456789abcdef01234567", policyVersion: "2.0.0", createdAt: "2026-08-09T00:00:00.000Z", workstreams: [{ workstreamId: "a", runId: "run", planId: "sha-plan", resolvedAgent: "backend-coder", requiredCapability: "backend", objective: "write", requirements: ["r"], acceptanceCriteria: ["a"], ownedPaths: ["src/**"], ownedSymbols: [], dependsOn: [], strategy: "direct", budgetProfile: "normal", contextScope: "owned", status: "planned", blockedBy: [], createdAt: "2026-08-09T00:00:00.000Z" }] }
    repo.savePlan(plan)
    const manager = { allocate: () => { throw new Error("must not allocate") }, remove: () => {} }
    const service = new WorktreeExecutionService(repo, new ExecutionScheduler(repo), manager as never)
    await expect(service.executePlan(plan.planId, "fedcba98765432100123456789abcdef01234567", { execute: async () => "succeeded" })).rejects.toThrow("EXECUTION_SOURCE_SHA_MISMATCH")
  })
})
