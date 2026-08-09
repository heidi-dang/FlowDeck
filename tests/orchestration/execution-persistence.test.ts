import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runMigrations } from "../../src/orchestration/persistence/migrations/migration-runner"
import { createTransactionManager } from "../../src/orchestration/persistence/transaction-manager"
import { SqliteExecutionRepository, ExecutionScheduler, type ExecutionPlan } from "../../src/orchestration/execution"

describe("durable execution runtime persistence", () => {
  let db: Database; let repo: SqliteExecutionRepository
  beforeEach(() => { db = new Database(":memory:"); runMigrations(db); db.query("INSERT INTO contract_families VALUES ('f','f',NULL,'test',datetime('now'))").run(); db.query("INSERT INTO task_contracts(contract_id,family_id,version,title,description,repo_url,repo_sha,created_by,created_at) VALUES ('c','f',1,'c','c','https://example.test','0123456789abcdef0123456789abcdef01234567','test',datetime('now'))").run(); db.query("INSERT INTO task_runs(run_id,contract_id,strategy,state,baseline_sha,repo_branch,created_at,created_ts) VALUES ('run','c','planned','planning','0123456789abcdef0123456789abcdef01234567','main',datetime('now'),strftime('%s','now'))").run(); repo = new SqliteExecutionRepository(db, createTransactionManager(db)) })
  afterEach(() => db.close())
  const plan = (): ExecutionPlan => ({ planId: "plan", runId: "run", routingDecisionId: "decision", sourceSha: "0123456789abcdef0123456789abcdef01234567", policyVersion: "2.0.0", createdAt: "2026-08-09T00:00:00.000Z", workstreams: [{ workstreamId: "a", runId: "run", planId: "plan", resolvedAgent: "backend-coder", requiredCapability: "backend", objective: "implement", requirements: ["r"], acceptanceCriteria: ["a"], ownedPaths: ["src/api/a.ts"], ownedSymbols: [], dependsOn: [], strategy: "direct", budgetProfile: "normal", contextScope: "owned", status: "planned", blockedBy: [], createdAt: "2026-08-09T00:00:00.000Z" }] })
  it("round-trips plans and reconstructs ready workstreams", () => { const saved = repo.savePlan(plan()); expect(saved.status).toBe("planned"); expect(repo.getPlan("plan")).toEqual(saved); expect(repo.listReady("plan").map(w => w.workstreamId)).toEqual(["a"]); expect(() => repo.savePlan(plan())).toThrow("EXECUTION_PLAN_IMMUTABLE") })
  it("enforces legal transitions and durable lease exclusivity", () => { repo.savePlan(plan()); repo.transitionWorkstream("plan", "a", "ready"); repo.transitionWorkstream("plan", "a", "running"); const lease = { leaseId: "lease", runId: "run", planId: "plan", workstreamId: "a", agentId: "backend-coder", worktreeId: "wt", workspace: "/tmp/wt", branch: "fd/plan/a", acquiredAt: "2026-08-09T00:00:00.000Z", renewedAt: "2026-08-09T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" }; expect(repo.acquireLease(lease).state).toBe("allocated"); expect(() => repo.acquireLease({ ...lease, leaseId: "lease-2", agentId: "other" })).toThrow("WORKTREE_LEASE_CONFLICT"); expect(repo.releaseLease("lease").state).toBe("released") })
  it("reclaims expired leases and rejects duplicate integration", () => { repo.savePlan(plan()); const lease = { leaseId: "lease", runId: "run", planId: "plan", workstreamId: "a", agentId: "a", worktreeId: "wt", workspace: "/tmp/wt", branch: "fd/plan/a", acquiredAt: "2020-01-01T00:00:00.000Z", renewedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:00:00.000Z" }; repo.acquireLease(lease); expect(repo.reclaimExpired("2021-01-01T00:00:00.000Z")).toBe(1); const attempt = { attemptId: "i", planId: "plan", workstreamId: "a", sourceSha: lease.branch.padEnd(40, "0").slice(0, 40), branch: lease.branch, status: "integrated" as const, verification: {}, evidence: {}, createdAt: "2026-08-09T00:00:00.000Z" }; repo.recordIntegration(attempt); expect(repo.hasIntegrated("a")).toBe(true); expect(() => repo.recordIntegration(attempt)).toThrow(); expect(() => repo.recordIntegration({ ...attempt, attemptId: "i-2" })).toThrow() })
  it("runs independent work in parallel and blocks transitive dependents after failure", async () => { const p = plan(); p.planId = "plan-2"; p.workstreams = [{ ...p.workstreams[0], workstreamId: "a", planId: "plan-2", ownedPaths: ["src/a.ts"] }, { ...p.workstreams[0], workstreamId: "b", planId: "plan-2", ownedPaths: ["src/b.ts"] }, { ...p.workstreams[0], workstreamId: "c", planId: "plan-2", ownedPaths: ["src/c.ts"], dependsOn: ["a"] }, { ...p.workstreams[0], workstreamId: "d", planId: "plan-2", ownedPaths: ["src/d.ts"], dependsOn: ["c"] }]; repo.savePlan(p); const scheduler = new ExecutionScheduler(repo); const result = await scheduler.runReady("plan-2", { execute: async w => w.workstreamId === "a" ? "failed" : "succeeded" }); expect(result.started).toEqual(["a", "b"]); expect(result.failed).toEqual(["a"]); expect(result.succeeded).toEqual(["b"]); expect(result.blocked).toEqual(["c", "d"]); expect(repo.getPlan("plan-2")!.workstreams.filter(w => ["c", "d"].includes(w.workstreamId)).every(w => w.status === "blocked")).toBe(true); expect(repo.getPlan("plan-2")!.status).toBe("failed") })

  it("rejects cyclic or overlapping plans before any plan rows become authoritative", () => {
    const cyclic = plan(); cyclic.planId = "cyclic"; cyclic.workstreams = [
      { ...cyclic.workstreams[0], planId: "cyclic", workstreamId: "a", ownedPaths: ["src/a.ts"], dependsOn: ["b"] },
      { ...cyclic.workstreams[0], planId: "cyclic", workstreamId: "b", ownedPaths: ["src/b.ts"], dependsOn: ["a"] },
    ]
    expect(() => repo.savePlan(cyclic)).toThrow("DEPENDENCY_CYCLE")
    expect(repo.getPlan("cyclic")).toBeNull()

    const overlapping = plan(); overlapping.planId = "overlap"; overlapping.workstreams = [
      { ...overlapping.workstreams[0], planId: "overlap", workstreamId: "a", ownedPaths: ["src/api/**"] },
      { ...overlapping.workstreams[0], planId: "overlap", workstreamId: "b", ownedPaths: ["src/api/users.ts"] },
    ]
    expect(() => repo.savePlan(overlapping)).toThrow("OVERLAPPING_OWNERSHIP")
    expect(repo.getPlan("overlap")).toBeNull()
  })

  it("enforces live worktree uniqueness at the database boundary", () => {
    repo.savePlan(plan())
    const lease = { leaseId: "lease-db", runId: "run", planId: "plan", workstreamId: "a", agentId: "a", worktreeId: "wt-db", workspace: "/tmp/wt-db", branch: "fd/plan/a", acquiredAt: "2026-08-09T00:00:00.000Z", renewedAt: "2026-08-09T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" }
    repo.acquireLease(lease)
    db.query("UPDATE execution_worktree_leases SET state = 'active' WHERE lease_id = ?").run("lease-db")
    expect(() => db.query("INSERT INTO execution_worktree_leases (lease_id,run_id,plan_id,workstream_id,agent_id,worktree_id,workspace,branch,acquired_at,renewed_at,expires_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,'allocated')").run("lease-db-2", "run", "plan", "a", "other", "wt-db", "/tmp/wt-db-2", "fd/plan/a-2", "2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z", "2999-01-01T00:00:00.000Z")).toThrow()
  })

  it("repairs a durable integration commit that was acknowledged before the status update", () => {
    repo.savePlan(plan())
    repo.transitionWorkstream("plan", "a", "ready")
    repo.transitionWorkstream("plan", "a", "running")
    repo.transitionWorkstream("plan", "a", "succeeded")
    repo.recordIntegration({ attemptId: "crash", planId: "plan", workstreamId: "a", sourceSha: "0123456789abcdef0123456789abcdef01234567", branch: "flowdeck/a", status: "integrated", verification: { clean: true }, evidence: {}, createdAt: "2026-08-09T00:00:00.000Z" })
    expect(repo.getPlan("plan")!.workstreams[0].status).toBe("succeeded")
    expect(repo.reconcileIntegratedAttempts()).toBe(1)
    expect(repo.getPlan("plan")!.workstreams[0].status).toBe("integrated")
    expect(repo.reconcileIntegratedAttempts()).toBe(0)
  })

  it("persists legal plan status transitions", () => {
    repo.savePlan(plan())
    expect(repo.transitionPlanStatus("plan", "running").status).toBe("running")
    expect(() => repo.transitionPlanStatus("plan", "planned")).toThrow("INVALID_EXECUTION_PLAN_TRANSITION")
    expect(repo.transitionPlanStatus("plan", "cancelled").status).toBe("cancelled")
  })

  it("reconstructs plans and leases after a database restart", () => {
    const root = mkdtempSync(join(tmpdir(), "flowdeck-execution-db-")); const path = join(root, "runtime.db")
    db.close()
    const first = new Database(path); runMigrations(first)
    first.query("INSERT INTO contract_families VALUES ('f','f',NULL,'test',datetime('now'))").run(); first.query("INSERT INTO task_contracts(contract_id,family_id,version,title,description,repo_url,repo_sha,created_by,created_at) VALUES ('c','f',1,'c','c','https://example.test','0123456789abcdef0123456789abcdef01234567','test',datetime('now'))").run(); first.query("INSERT INTO task_runs(run_id,contract_id,strategy,state,baseline_sha,repo_branch,created_at,created_ts) VALUES ('run','c','planned','planning','0123456789abcdef0123456789abcdef01234567','main',datetime('now'),strftime('%s','now'))").run()
    const firstRepo = new SqliteExecutionRepository(first, createTransactionManager(first)); firstRepo.savePlan(plan()); firstRepo.acquireLease({ leaseId: "restart-lease", runId: "run", planId: "plan", workstreamId: "a", agentId: "a", worktreeId: "restart-wt", workspace: "/tmp/restart-wt", branch: "flowdeck/restart", acquiredAt: "2026-08-09T00:00:00.000Z", renewedAt: "2026-08-09T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" }); first.close()
    const second = new Database(path); runMigrations(second); const secondRepo = new SqliteExecutionRepository(second, createTransactionManager(second))
    expect(secondRepo.getPlan("plan")!.workstreams[0].workstreamId).toBe("a")
    expect(secondRepo.getLease("restart-lease")!.worktreeId).toBe("restart-wt")
    second.close(); rmSync(root, { recursive: true, force: true })
  })
})
