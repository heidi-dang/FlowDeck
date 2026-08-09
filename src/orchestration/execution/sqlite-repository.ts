import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../persistence/transaction-manager"
import type { OrchestrationMetrics } from "../metrics"
import { analyzeDependencies, assertPlanTransition, executionPlanSchema, type ExecutionPlan, type ExecutionWorkstream, assertWorkstreamTransition, normalizeOwnership, type ExecutionLeaseState, type ExecutionPlanStatus } from "./contracts"

const ACTIVE_LEASES = "('requested','allocated','active','renewing')"
const json = (value: unknown) => JSON.stringify(value)
const parse = <T>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value)) as T } catch { return fallback } }

export interface WorktreeLeaseInput { leaseId: string; runId: string; planId: string; workstreamId: string; agentId: string; worktreeId: string; workspace: string; branch: string; acquiredAt: string; renewedAt: string; expiresAt: string }
export interface WorktreeLease extends WorktreeLeaseInput { state: ExecutionLeaseState }
export interface IntegrationAttempt { attemptId: string; planId: string; workstreamId: string; sourceSha: string; branch: string; status: "started" | "verified" | "conflict" | "integrated" | "failed" | "cancelled"; verification: Record<string, unknown>; evidence: Record<string, unknown>; error?: string; createdAt: string; completedAt?: string }

/** Authoritative M2 persistence. All execution authority is SQLite-backed and reconstructed from rows. */
export class SqliteExecutionRepository {
  constructor(private readonly db: Database, private readonly tx: TransactionManager, private readonly metrics?: OrchestrationMetrics) {}

  savePlan(plan: ExecutionPlan): ExecutionPlan {
    const parsedInput = executionPlanSchema.parse(plan)
    const parsed: ExecutionPlan = { ...parsedInput, status: parsedInput.status ?? "planned" }
    if (parsed.workstreams.some(w => w.planId !== parsed.planId || w.runId !== parsed.runId)) throw new Error("EXECUTION_PLAN_ID_MISMATCH")
    analyzeDependencies(parsed)
    const saved = this.tx.write(() => {
      if (this.db.query("SELECT 1 FROM execution_plans WHERE plan_id = ?").get(parsed.planId)) throw new Error("EXECUTION_PLAN_IMMUTABLE")
      this.db.query(`INSERT INTO execution_plans (plan_id,run_id,routing_decision_id,source_sha,policy_version,created_at,status,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(parsed.planId, parsed.runId, parsed.routingDecisionId, parsed.sourceSha, parsed.policyVersion, parsed.createdAt, parsed.status ?? "planned", parsed.startedAt ?? null, parsed.completedAt ?? null)
      for (const workstream of parsed.workstreams) {
        this.insertWorkstream(parsed, workstream)
        for (const dependency of workstream.dependsOn) this.db.query("INSERT INTO execution_dependencies(plan_id,workstream_id,depends_on) VALUES(?,?,?)").run(parsed.planId, workstream.workstreamId, dependency)
        for (const owned of normalizeOwnership(workstream.ownedPaths)) {
          const type = owned.endsWith("/**") || owned.endsWith("/*") ? "pattern" : owned.endsWith("/") ? "directory" : "file"
          this.db.query(`INSERT INTO execution_ownership_claims (claim_id,plan_id,run_id,workstream_id,ownership_type,ownership_value,normalized_value,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(`${parsed.planId}:${workstream.workstreamId}:${owned}`, parsed.planId, parsed.runId, workstream.workstreamId, type, owned, owned, parsed.createdAt)
        }
      }
      return parsed
    })
    this.metrics?.executionPlans.inc()
    return saved
  }

  private insertWorkstream(plan: ExecutionPlan, w: ExecutionWorkstream): void {
    this.db.query(`INSERT INTO execution_workstreams (workstream_id,plan_id,run_id,resolved_agent,required_capability,objective,requirements_json,acceptance_criteria_json,owned_paths_json,owned_symbols_json,strategy,budget_profile,context_scope,status,worktree_ref,branch_ref,blocked_by_json,failure_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      w.workstreamId, plan.planId, plan.runId, w.resolvedAgent, w.requiredCapability, w.objective, json(w.requirements), json(w.acceptanceCriteria), json(w.ownedPaths), json(w.ownedSymbols), w.strategy, w.budgetProfile, w.contextScope, w.status, w.worktreeRef ?? null, w.branchRef ?? null, json(w.blockedBy), w.failureReason ?? null, w.createdAt, w.createdAt,
    )
  }

  getPlan(planId: string): ExecutionPlan | null {
    const row = this.db.query("SELECT * FROM execution_plans WHERE plan_id = ?").get(planId) as Record<string, unknown> | null
    if (!row) return null
    const rows = this.db.query("SELECT * FROM execution_workstreams WHERE plan_id = ? ORDER BY workstream_id").all(planId) as Record<string, unknown>[]
    const deps = this.db.query("SELECT workstream_id, depends_on FROM execution_dependencies WHERE plan_id = ? ORDER BY workstream_id, depends_on").all(planId) as Array<{ workstream_id: string; depends_on: string }>
    const byDeps = new Map<string, string[]>(); for (const d of deps) byDeps.set(d.workstream_id, [...(byDeps.get(d.workstream_id) ?? []), d.depends_on])
    const workstreams = rows.map(r => ({ workstreamId: r.workstream_id as string, runId: r.run_id as string, planId: r.plan_id as string, resolvedAgent: r.resolved_agent as string, requiredCapability: r.required_capability as string, objective: r.objective as string, requirements: parse(r.requirements_json, [] as string[]), acceptanceCriteria: parse(r.acceptance_criteria_json, [] as string[]), ownedPaths: parse(r.owned_paths_json, [] as string[]), ownedSymbols: parse(r.owned_symbols_json, [] as string[]), dependsOn: byDeps.get(r.workstream_id as string) ?? [], strategy: r.strategy as string, budgetProfile: r.budget_profile as ExecutionWorkstream["budgetProfile"], contextScope: r.context_scope as ExecutionWorkstream["contextScope"], status: r.status as ExecutionWorkstream["status"], ...(r.worktree_ref ? { worktreeRef: r.worktree_ref as string } : {}), ...(r.branch_ref ? { branchRef: r.branch_ref as string } : {}), blockedBy: parse(r.blocked_by_json, [] as string[]), ...(r.failure_reason ? { failureReason: r.failure_reason as string } : {}), createdAt: r.created_at as string }))
    return executionPlanSchema.parse({ planId: row.plan_id, runId: row.run_id, routingDecisionId: row.routing_decision_id, sourceSha: row.source_sha, policyVersion: row.policy_version, createdAt: row.created_at, status: row.status, startedAt: row.started_at ?? undefined, completedAt: row.completed_at ?? undefined, workstreams })
  }
  listPlansForRun(runId: string): ExecutionPlan[] { return (this.db.query("SELECT plan_id FROM execution_plans WHERE run_id = ? ORDER BY created_at, plan_id").all(runId) as Array<{ plan_id: string }>).map(r => this.getPlan(r.plan_id)!).filter(Boolean) }
  listPlans(): ExecutionPlan[] { return (this.db.query("SELECT plan_id FROM execution_plans ORDER BY created_at, plan_id").all() as Array<{ plan_id: string }>).map(r => this.getPlan(r.plan_id)!).filter(Boolean) }

  transitionWorkstream(planId: string, workstreamId: string, status: ExecutionWorkstream["status"], failureReason?: string, blockedBy: string[] = []): ExecutionWorkstream {
    return this.tx.write(() => {
      const row = this.db.query("SELECT * FROM execution_workstreams WHERE plan_id = ? AND workstream_id = ?").get(planId, workstreamId) as Record<string, unknown> | null
      if (!row) throw new Error("WORKSTREAM_NOT_FOUND")
      const from = row.status as ExecutionWorkstream["status"]; assertWorkstreamTransition(from, status)
      this.db.query("UPDATE execution_workstreams SET status = ?, failure_reason = ?, blocked_by_json = ?, updated_at = datetime('now') WHERE plan_id = ? AND workstream_id = ?").run(status, failureReason ?? null, json(blockedBy), planId, workstreamId)
      return this.getPlan(planId)!.workstreams.find(w => w.workstreamId === workstreamId)!
    })
  }
  transitionPlanStatus(planId: string, status: ExecutionPlanStatus): ExecutionPlan {
    return this.tx.write(() => {
      const row = this.db.query("SELECT status FROM execution_plans WHERE plan_id = ?").get(planId) as { status: ExecutionPlanStatus } | null
      if (!row) throw new Error("EXECUTION_PLAN_NOT_FOUND")
      assertPlanTransition(row.status, status)
      const now = new Date().toISOString()
      this.db.query("UPDATE execution_plans SET status = ?, started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END, completed_at = CASE WHEN ? IN ('succeeded','failed','cancelled','superseded') THEN ? ELSE completed_at END WHERE plan_id = ?").run(status, status, now, status, now, planId)
      return this.getPlan(planId)!
    })
  }
  bindWorktree(planId: string, workstreamId: string, worktreeRef: string, branchRef: string): void { this.tx.write(() => { const row = this.db.query("SELECT status FROM execution_workstreams WHERE plan_id = ? AND workstream_id = ?").get(planId, workstreamId) as { status: string } | null; if (!row) throw new Error("WORKSTREAM_NOT_FOUND"); if (!["planned", "ready"].includes(row.status)) throw new Error("WORKTREE_BINDING_TOO_LATE"); this.db.query("UPDATE execution_workstreams SET worktree_ref = ?, branch_ref = ?, updated_at = datetime('now') WHERE plan_id = ? AND workstream_id = ?").run(worktreeRef, branchRef, planId, workstreamId) }) }

  listReady(planId: string): ExecutionWorkstream[] {
    const plan = this.getPlan(planId); if (!plan) throw new Error("EXECUTION_PLAN_NOT_FOUND")
    const state = new Map(plan.workstreams.map(w => [w.workstreamId, w.status]));
    return plan.workstreams.filter(w => (w.status === "planned" || w.status === "ready") && w.dependsOn.every(d => state.get(d) === "succeeded" || state.get(d) === "integrated")).sort((a, b) => a.workstreamId.localeCompare(b.workstreamId))
  }

  acquireLease(input: WorktreeLeaseInput): WorktreeLease {
    try { return this.tx.write(() => {
      const live = this.db.query(`SELECT lease_id FROM execution_worktree_leases WHERE (worktree_id = ? OR workstream_id = ?) AND state IN ${ACTIVE_LEASES} AND expires_at > datetime('now')`).get(input.worktreeId, input.workstreamId)
      if (live) throw new Error("WORKTREE_LEASE_CONFLICT")
      this.db.query(`INSERT INTO execution_worktree_leases (lease_id,run_id,plan_id,workstream_id,agent_id,worktree_id,workspace,branch,acquired_at,renewed_at,expires_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,'allocated')`).run(input.leaseId, input.runId, input.planId, input.workstreamId, input.agentId, input.worktreeId, input.workspace, input.branch, input.acquiredAt, input.renewedAt, input.expiresAt)
      return { ...input, state: "allocated" as const }
    }) } catch (error) { if (String(error).includes("WORKTREE_LEASE_CONFLICT") || String(error).includes("UNIQUE")) this.metrics?.worktreeLeaseConflicts.inc(); throw error }
  }

  activateLease(leaseId: string): WorktreeLease {
    return this.tx.write(() => {
      const row = this.db.query(`SELECT * FROM execution_worktree_leases WHERE lease_id = ? AND state IN ${ACTIVE_LEASES}`).get(leaseId) as Record<string, unknown> | null
      if (!row) throw new Error("LEASE_NOT_ACTIVE")
      this.db.query("UPDATE execution_worktree_leases SET state = 'active' WHERE lease_id = ?").run(leaseId)
      return this.getLease(leaseId)!
    })
  }
  renewLease(leaseId: string, renewedAt: string, expiresAt: string): WorktreeLease { return this.tx.write(() => { const row = this.db.query(`SELECT * FROM execution_worktree_leases WHERE lease_id = ? AND state IN ${ACTIVE_LEASES}`).get(leaseId) as Record<string, unknown> | null; if (!row) throw new Error("LEASE_NOT_ACTIVE"); this.db.query("UPDATE execution_worktree_leases SET renewed_at = ?, expires_at = ?, state = 'renewing' WHERE lease_id = ?").run(renewedAt, expiresAt, leaseId); return this.getLease(leaseId)! }) }
  completeLease(leaseId: string): WorktreeLease { return this.tx.write(() => { const row = this.db.query(`SELECT * FROM execution_worktree_leases WHERE lease_id = ? AND state IN ${ACTIVE_LEASES}`).get(leaseId) as Record<string, unknown> | null; if (!row) throw new Error("LEASE_NOT_ACTIVE"); this.db.query("UPDATE execution_worktree_leases SET state = 'completed' WHERE lease_id = ?").run(leaseId); return this.getLease(leaseId)! }) }
  releaseLease(leaseId: string): WorktreeLease { return this.tx.write(() => { this.db.query("UPDATE execution_worktree_leases SET state = 'released' WHERE lease_id = ? AND state <> 'released'").run(leaseId); return this.getLease(leaseId)! }) }
  reclaimExpired(now: string): number { const count = this.tx.write(() => this.db.query(`UPDATE execution_worktree_leases SET state = 'reclaimable' WHERE state IN ${ACTIVE_LEASES} AND expires_at <= ?`).run(now).changes); if (count) this.metrics?.worktreeLeaseReclaims.inc(count); return count }
  getLease(leaseId: string): WorktreeLease | null { const r = this.db.query("SELECT * FROM execution_worktree_leases WHERE lease_id = ?").get(leaseId) as Record<string, unknown> | null; return r ? { leaseId: r.lease_id as string, runId: r.run_id as string, planId: r.plan_id as string, workstreamId: r.workstream_id as string, agentId: r.agent_id as string, worktreeId: r.worktree_id as string, workspace: r.workspace as string, branch: r.branch as string, acquiredAt: r.acquired_at as string, renewedAt: r.renewed_at as string, expiresAt: r.expires_at as string, state: r.state as ExecutionLeaseState } : null }
  listLeases(runId: string): WorktreeLease[] { return (this.db.query("SELECT * FROM execution_worktree_leases WHERE run_id = ? ORDER BY acquired_at").all(runId) as Record<string, unknown>[]).map(r => this.getLease(r.lease_id as string)!) }
  listAllLeases(): WorktreeLease[] { return (this.db.query("SELECT lease_id FROM execution_worktree_leases ORDER BY acquired_at, lease_id").all() as Array<{ lease_id: string }>).map(r => this.getLease(r.lease_id)!).filter(Boolean) }

  /**
   * Reconstructs safe restart state without guessing that an in-flight agent
   * completed. Active workstreams return to the ready queue; a later dispatch
   * must acquire a fresh lease. Integration acknowledgements are repaired
   * first so an acknowledged commit is never executed twice.
   */
  recoverAfterRestart(now: string): { recoveredWorkstreams: string[]; reclaimedLeases: number; repairedIntegrations: number } {
    const repairedIntegrations = this.reconcileIntegratedAttempts()
    const rows = this.db.query("SELECT plan_id, workstream_id FROM execution_workstreams WHERE status = 'running' ORDER BY plan_id, workstream_id").all() as Array<{ plan_id: string; workstream_id: string }>
    const recoveredWorkstreams = rows.map(row => {
      this.transitionWorkstream(row.plan_id, row.workstream_id, "ready", "ORCHESTRATOR_RESTART")
      this.tx.write(() => this.db.query(`UPDATE execution_worktree_leases SET state = 'reclaimable' WHERE plan_id = ? AND workstream_id = ? AND state IN ${ACTIVE_LEASES}`).run(row.plan_id, row.workstream_id))
      return `${row.plan_id}:${row.workstream_id}`
    })
    const reclaimedLeases = this.reclaimExpired(now)
    return { recoveredWorkstreams, reclaimedLeases, repairedIntegrations }
  }

  recordIntegration(attempt: IntegrationAttempt): IntegrationAttempt { const result = this.tx.write(() => { this.db.query("INSERT INTO execution_integration_attempts (attempt_id,plan_id,workstream_id,source_sha,branch,status,verification_json,evidence_json,error,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(attempt.attemptId, attempt.planId, attempt.workstreamId, attempt.sourceSha, attempt.branch, attempt.status, json(attempt.verification), json(attempt.evidence), attempt.error ?? null, attempt.createdAt, attempt.completedAt ?? null); return attempt }); this.metrics?.integrationAttempts.inc(); if (attempt.status === "integrated") this.metrics?.integrationsCompleted.inc(); if (["conflict", "failed"].includes(attempt.status)) this.metrics?.integrationConflicts.inc(); return result }
  listIntegrationAttempts(status?: IntegrationAttempt["status"]): IntegrationAttempt[] {
    const rows = (status
      ? this.db.query("SELECT * FROM execution_integration_attempts WHERE status = ? ORDER BY created_at, attempt_id").all(status)
      : this.db.query("SELECT * FROM execution_integration_attempts ORDER BY created_at, attempt_id").all()) as Record<string, unknown>[]
    return rows.map(row => ({
      attemptId: row.attempt_id as string,
      planId: row.plan_id as string,
      workstreamId: row.workstream_id as string,
      sourceSha: row.source_sha as string,
      branch: row.branch as string,
      status: row.status as IntegrationAttempt["status"],
      verification: parse(row.verification_json, {} as Record<string, unknown>),
      evidence: parse(row.evidence_json, {} as Record<string, unknown>),
      ...(row.error ? { error: row.error as string } : {}),
      createdAt: row.created_at as string,
      ...(row.completed_at ? { completedAt: row.completed_at as string } : {}),
    }))
  }
  hasIntegrated(workstreamId: string): boolean { return Boolean(this.db.query("SELECT 1 FROM execution_integration_attempts WHERE workstream_id = ? AND status = 'integrated'").get(workstreamId)) }
  reconcileIntegratedAttempts(): number {
    return this.tx.write(() => {
      const table = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_integration_attempts'").get()
      if (!table) return 0
      const rows = this.db.query("SELECT plan_id, workstream_id FROM execution_integration_attempts WHERE status = 'integrated'").all() as Array<{ plan_id: string; workstream_id: string }>
      let repaired = 0
      for (const row of rows) {
        const current = this.db.query("SELECT status FROM execution_workstreams WHERE plan_id = ? AND workstream_id = ?").get(row.plan_id, row.workstream_id) as { status: string } | null
        if (current && ["succeeded", "integration_pending"].includes(current.status)) {
          repaired += this.db.query("UPDATE execution_workstreams SET status = 'integrated', updated_at = datetime('now') WHERE plan_id = ? AND workstream_id = ? AND status IN ('succeeded','integration_pending')").run(row.plan_id, row.workstream_id).changes
        }
      }
      return repaired
    })
  }
}
