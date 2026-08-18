import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runMigrations } from "../src/orchestration/persistence/migrations/migration-runner"
import { createTransactionManager } from "../src/orchestration/persistence/transaction-manager"
import { SqliteExecutionRepository, GitWorktreeManager } from "../src/orchestration/execution"
import type { WorktreeLeaseInput } from "../src/orchestration/execution/sqlite-repository"
import type { ExecutionPlan } from "../src/orchestration/execution/contracts"

describe("v2 hardening boundaries", () => {
  it("allows exactly one live owner during a twenty-way lease race", async () => {
    const db = new Database(":memory:")
    try {
      runMigrations(db)
      const repo = new SqliteExecutionRepository(db, createTransactionManager(db))
      const base: WorktreeLeaseInput = { leaseId: "lease-0", runId: "race-run", planId: "race-plan", workstreamId: "race-workstream", agentId: "agent", worktreeId: "race-worktree", workspace: "/tmp/race-worktree", branch: "flowdeck/race", acquiredAt: "2026-08-09T00:00:00.000Z", renewedAt: "2026-08-09T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" }
      const results = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => { try { repo.acquireLease({ ...base, leaseId: `lease-${index}` }); return true } catch { return false } })))
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(repo.listLeases("race-run").filter(lease => ["allocated", "active", "renewing"].includes(lease.state))).toHaveLength(1)
    } finally { db.close() }
  })

  it("rejects symlink escapes and traversal before integration", () => {
    const root = mkdtempSync(join(tmpdir(), "flowdeck-security-"))
    const repo = join(root, "repo")
    const worktrees = join(root, "worktrees")
    const outside = join(root, "outside")
    mkdirSync(repo); mkdirSync(outside); writeFileSync(join(outside, "secret.txt"), "secret")
    execFileSync("git", ["init", "-q"], { cwd: repo }); execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repo }); execFileSync("git", ["config", "user.name", "test"], { cwd: repo }); writeFileSync(join(repo, "README.md"), "root\n"); execFileSync("git", ["add", "README.md"], { cwd: repo }); execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo })
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
    const manager = new GitWorktreeManager(repo, worktrees)
    const allocation = manager.allocate("run", "../writer;rm -rf", sha)
    try {
      expect(allocation.branch).not.toContain("..")
      expect(() => manager.assertOwnedPath(allocation.workspace, "../escape")).toThrow("OWNERSHIP_PATH_ESCAPE")
      symlinkSync(join(outside, "secret.txt"), join(allocation.workspace, "linked.txt"))
      expect(() => manager.assertOwnedPath(allocation.workspace, "linked.txt")).toThrow("SYMLINK_ESCAPE")
      mkdirSync(join(allocation.workspace, "src"))
      symlinkSync(outside, join(allocation.workspace, "src", "external"))
      expect(() => manager.assertOwnedPath(allocation.workspace, "src/external/new.ts")).toThrow("SYMLINK_ESCAPE")
      expect(() => manager.assertOwnedPath(allocation.workspace, "C:/outside.txt")).toThrow("OWNERSHIP_PATH_ESCAPE")
    } finally { manager.remove(allocation); rmSync(root, { recursive: true, force: true }) }
  })

  it("keeps WAL recovery and integrity checks explicit", () => {
    const root = mkdtempSync(join(tmpdir(), "flowdeck-wal-"))
    const db = new Database(join(root, "runtime.db"))
    try { runMigrations(db); expect(db.query("PRAGMA journal_mode = WAL").get()).toBeDefined(); expect((db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok") } finally {
      try { db.close() } catch {}
      // Windows may briefly hold -wal/-shm after close; best-effort retry teardown.
      for (const f of ["runtime.db-wal", "runtime.db-shm"]) { try { rmSync(join(root, f), { force: true }) } catch {} }
      try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch {}
    }
  })

  it("allows only one durable integration acknowledgement during a twenty-way race", async () => {
    const db = new Database(":memory:")
    try {
      runMigrations(db)
      db.query("INSERT INTO contract_families VALUES ('f','f',NULL,'test',datetime('now'))").run()
      db.query("INSERT INTO task_contracts(contract_id,family_id,version,title,description,repo_url,repo_sha,created_by,created_at) VALUES ('c','f',1,'c','c','https://example.test','0123456789abcdef0123456789abcdef01234567','test',datetime('now'))").run()
      db.query("INSERT INTO task_runs(run_id,contract_id,strategy,state,baseline_sha,repo_branch,created_at,created_ts) VALUES ('integration-race-run','c','planned','planning','0123456789abcdef0123456789abcdef01234567','main',datetime('now'),strftime('%s','now'))").run()
      const repo = new SqliteExecutionRepository(db, createTransactionManager(db))
      const plan: ExecutionPlan = { planId: "integration-race-plan", runId: "integration-race-run", routingDecisionId: "integration-race-decision", sourceSha: "0123456789abcdef0123456789abcdef01234567", policyVersion: "2.0.0", createdAt: "2026-08-09T00:00:00.000Z", workstreams: [{ workstreamId: "integration-race-workstream", runId: "integration-race-run", planId: "integration-race-plan", resolvedAgent: "backend-coder", requiredCapability: "backend", objective: "race", requirements: ["r"], acceptanceCriteria: ["a"], ownedPaths: ["src/race.ts"], ownedSymbols: [], dependsOn: [], strategy: "direct", budgetProfile: "small", contextScope: "owned", status: "planned", blockedBy: [], createdAt: "2026-08-09T00:00:00.000Z" }] }
      repo.savePlan(plan)
      repo.transitionWorkstream(plan.planId, "integration-race-workstream", "ready")
      repo.transitionWorkstream(plan.planId, "integration-race-workstream", "running")
      repo.transitionWorkstream(plan.planId, "integration-race-workstream", "succeeded")
      const attempt = { attemptId: "integration-race-attempt", planId: plan.planId, workstreamId: "integration-race-workstream", sourceSha: plan.sourceSha, branch: "flowdeck/integration-race", status: "integrated" as const, verification: { passed: true }, evidence: { committed: true }, createdAt: "2026-08-09T00:00:00.000Z" }
      const results = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => { try { repo.recordIntegration(attempt); return true } catch { return false } })))
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(repo.listIntegrationAttempts()).toHaveLength(1)
    } finally { db.close() }
  })
})
