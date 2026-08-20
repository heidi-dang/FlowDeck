import { randomUUID } from "node:crypto"
import type { ExecutionWorkstream } from "./contracts"
import type { SqliteExecutionRepository } from "./sqlite-repository"
import { ExecutionScheduler } from "./scheduler"
import type { GitWorktreeManager, WorktreeAllocation } from "./worktree-manager"
import type { WorkstreamBudgetHandle } from "../../services/adaptive-execution-control"
import type { PerformanceOutcomeFacts, SqlitePerformanceRepository } from "../performance/sqlite-repository"
import { buildWorkstreamContext } from "./context"
import { buildRuntimeProjection } from "../../services/runtime-projection"

export interface IsolatedExecutionResult extends PerformanceOutcomeFacts {}
export interface IsolatedWorkstreamExecutor { execute(workstream: ExecutionWorkstream, allocation: WorktreeAllocation, budget?: WorkstreamBudgetHandle, context?: any): Promise<"succeeded" | "failed" | IsolatedExecutionResult> }
export interface IntegrationCoordinator { integrate(workstream: ExecutionWorkstream, sourceSha: string, branch: string, workspace: string): void; currentSourceSha?: () => string; recoverAfterRestart?: () => number }
export interface WorkstreamBudgetCoordinator {
  open(workstream: ExecutionWorkstream): WorkstreamBudgetHandle
  redistribute?(workstream: ExecutionWorkstream, amount: number, reason: string, sourceReservationId?: string): Promise<{ allowed: boolean; reservationId: string; amount: number }>
}
export class WorktreeExecutionService {
  constructor(private readonly repository: SqliteExecutionRepository, private readonly scheduler: ExecutionScheduler, private readonly worktrees: GitWorktreeManager, private readonly integration?: IntegrationCoordinator, private budgetCoordinator?: WorkstreamBudgetCoordinator, private readonly performance?: SqlitePerformanceRepository) {}
  setBudgetCoordinator(coordinator: WorkstreamBudgetCoordinator): void { this.budgetCoordinator = coordinator }
  /** Reconcile durable execution state before accepting new dispatches. */
  recoverAfterRestart(now = new Date().toISOString()): { recoveredWorkstreams: string[]; reclaimedLeases: number; repairedIntegrations: number } {
    const integrationRepairs = this.integration?.recoverAfterRestart?.() ?? 0
    const recovery = this.repository.recoverAfterRestart(now)
    for (const lease of this.repository.listAllLeases().filter(item => item.state === "reclaimable")) {
      const plan = this.repository.getPlan(lease.planId)
      if (plan) {
        try {
          this.worktrees.remove({ worktreeId: lease.worktreeId, workspace: lease.workspace, branch: lease.branch, sourceSha: plan.sourceSha })
        } catch {
          // The worktree may already have been removed by an operator or a
          // previous recovery attempt; the durable lease remains authoritative.
        }
      }
      try { this.repository.releaseLease(lease.leaseId) } catch { /* idempotent recovery */ }
    }
    return { ...recovery, repairedIntegrations: recovery.repairedIntegrations + integrationRepairs }
  }
  async executePlan(planId: string, sourceSha: string, executor: IsolatedWorkstreamExecutor, runtimeProjection?: string): Promise<{ succeeded: string[]; failed: string[]; blocked: string[] }> {
    const initialPlan = this.repository.getPlan(planId)
    if (!initialPlan) throw new Error("EXECUTION_PLAN_NOT_FOUND")
    if (initialPlan.sourceSha !== sourceSha) throw new Error("EXECUTION_SOURCE_SHA_MISMATCH")
    const aggregate = { succeeded: [] as string[], failed: [] as string[], blocked: [] as string[] }
    const childRuntimeProjection = runtimeProjection ?? buildRuntimeProjection()
    for (let wave = 0; wave < 100; wave++) {
      const ready = this.repository.listReady(planId); if (!ready.length) break
      // A dependency wave must see the integrations from prior waves. The
      // plan's sourceSha remains the immutable provenance anchor, while each
      // wave is allocated from the current controlled-integration head.
      // Independent workstreams in one wave intentionally share that same
      // base and are integrated deterministically afterwards.
      const waveSourceSha = this.integration?.currentSourceSha?.() ?? sourceSha
      const allocations = new Map<string, WorktreeAllocation>()
      const budgets = new Map<string, WorkstreamBudgetHandle>()
      const facts = new Map<string, PerformanceOutcomeFacts>()
      try {
        for (const workstream of ready) {
          if (this.budgetCoordinator) budgets.set(workstream.workstreamId, this.budgetCoordinator.open(workstream))
          const allocation = this.worktrees.allocate(workstream.runId, workstream.workstreamId, waveSourceSha)
          // Git creates the worktree before the database can bind its lease.
          // Register it immediately so a failed bind/claim is still cleaned up
          // by the same failure path; otherwise a rejected concurrent claim
          // could leave an orphaned writable worktree behind.
          allocations.set(workstream.workstreamId, allocation)
          this.repository.bindWorktree(planId, workstream.workstreamId, allocation.worktreeId, allocation.branch)
          const lease = this.repository.acquireLease({ leaseId: randomUUID(), runId: workstream.runId, planId, workstreamId: workstream.workstreamId, agentId: workstream.resolvedAgent, worktreeId: allocation.worktreeId, workspace: allocation.workspace, branch: allocation.branch, acquiredAt: new Date().toISOString(), renewedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() })
          this.repository.activateLease(lease.leaseId)
        }
      } catch (error) {
        for (const allocation of allocations.values()) { const lease = this.repository.listLeases(this.repository.getPlan(planId)!.runId).find(l => l.worktreeId === allocation.worktreeId && ["allocated", "active", "renewing"].includes(l.state)); if (lease) this.repository.releaseLease(lease.leaseId); try { this.worktrees.remove(allocation) } catch {} }
        throw error
      }
      const result = await this.scheduler.runReady(planId, { execute: async workstream => { const allocation = allocations.get(workstream.workstreamId)!; const startedAt = Date.now(); try { const context = buildWorkstreamContext(workstream, [], childRuntimeProjection); const output = await executor.execute(workstream, allocation, budgets.get(workstream.workstreamId), context); const outcome = typeof output === "string" ? { status: output, integrationPassed: false, durationMs: Date.now() - startedAt } : { ...output, durationMs: output.durationMs ?? Date.now() - startedAt }; facts.set(workstream.workstreamId, outcome); return outcome.status } catch { facts.set(workstream.workstreamId, { status: "failed", integrationPassed: false, durationMs: Date.now() - startedAt, terminationReason: "execution_failed" }); return "failed" } } })
      for (const workstreamId of [...result.succeeded].sort()) {
        const allocation = allocations.get(workstreamId)!
        try {
          const workstream = this.repository.getPlan(planId)!.workstreams.find(w => w.workstreamId === workstreamId)!
          const recordedFacts = facts.get(workstreamId)
          if (this.integration && (!recordedFacts || recordedFacts.verificationPassed !== true)) throw new Error("VERIFICATION_REQUIRED_BEFORE_INTEGRATION")
          if (this.integration) this.integration.integrate(workstream, allocation.sourceSha, allocation.branch, allocation.workspace)
          const integrated = Boolean(this.integration)
          const outcomeFacts = facts.get(workstreamId) ?? { status: "succeeded" as const, integrationPassed: integrated, verificationPassed: integrated }
          this.performance?.recordWorkstreamOutcome(workstream, { ...outcomeFacts, status: "succeeded", integrationPassed: integrated, verificationPassed: outcomeFacts.verificationPassed === true && integrated })
        } catch {
          const current = this.repository.getPlan(planId)!.workstreams.find(w => w.workstreamId === workstreamId)!
          if (current.status === "succeeded") {
            this.repository.transitionWorkstream(planId, workstreamId, "integration_pending")
            this.repository.transitionWorkstream(planId, workstreamId, "failed", "INTEGRATION_FAILED")
          }
          result.succeeded = result.succeeded.filter(id => id !== workstreamId)
          result.failed.push(workstreamId)
          const outcomeFacts = facts.get(workstreamId) ?? { status: "failed" as const, integrationPassed: false }
          this.performance?.recordWorkstreamOutcome(current, { ...outcomeFacts, status: "failed", integrationPassed: false, terminationReason: "integration_failed" })
        }
      }
      for (const workstreamId of result.failed) {
        if (facts.has(workstreamId)) {
          const workstream = this.repository.getPlan(planId)!.workstreams.find(w => w.workstreamId === workstreamId)!
          this.performance?.recordWorkstreamOutcome(workstream, { ...facts.get(workstreamId)!, status: "failed", integrationPassed: false })
        }
      }
      for (const workstreamId of result.blocked) {
        const workstream = this.repository.getPlan(planId)!.workstreams.find(w => w.workstreamId === workstreamId)!
        await budgets.get(workstreamId)?.terminate("dependency_failed")
        this.performance?.recordWorkstreamOutcome(workstream, { status: "failed", integrationPassed: false, terminationReason: "dependency_failed" })
      }
      for (const workstreamId of result.failed) {
        const reason = facts.get(workstreamId)?.terminationReason
        const allowed = new Set(["duplicate", "superseded", "dependency_failed", "no_progress", "budget_exhausted", "policy_violation", "manual_cancel"])
        await budgets.get(workstreamId)?.terminate(allowed.has(reason ?? "") ? reason as "duplicate" | "superseded" | "dependency_failed" | "no_progress" | "budget_exhausted" | "policy_violation" | "manual_cancel" : "policy_violation")
      }
      // An integration/verification failure is discovered after the
      // scheduler's dispatch pass. Propagate that failure before deciding the
      // next wave so dependents cannot remain silently planned.
      const integrationBlocked = this.scheduler.propagateDependencyFailures(planId)
      result.blocked.push(...integrationBlocked)
      for (const workstreamId of integrationBlocked) {
        const workstream = this.repository.getPlan(planId)!.workstreams.find(w => w.workstreamId === workstreamId)!
        await budgets.get(workstreamId)?.terminate("dependency_failed")
        this.performance?.recordWorkstreamOutcome(workstream, { status: "failed", integrationPassed: false, terminationReason: "dependency_failed" })
      }
      for (const [workstreamId, allocation] of allocations) {
        const lease = this.repository.listLeases(this.repository.getPlan(planId)!.runId).find(l => l.workstreamId === workstreamId && ["allocated", "active", "renewing"].includes(l.state))
        if (lease) { try { this.repository.completeLease(lease.leaseId) } catch {} ; this.repository.releaseLease(lease.leaseId) }
        try { this.worktrees.remove(allocation) } catch { /* cleanup is recoverable through lease/worktree reconciliation */ }
      }
      if (this.budgetCoordinator?.redistribute) {
        const nextReady = this.repository.listReady(planId).sort((left, right) => (right.dependsOn.length - left.dependsOn.length) || left.workstreamId.localeCompare(right.workstreamId))[0]
        if (nextReady) {
          for (const workstreamId of [...result.succeeded].sort()) {
            const outcome = facts.get(workstreamId)
            const reclaimed = Math.max(0, Math.floor((outcome?.tokenReserved ?? 0) - (outcome?.tokenUsed ?? 0)))
            if (reclaimed <= 0) continue
            try { await this.budgetCoordinator.redistribute(nextReady, reclaimed, "completed_workstream_reclaim", outcome?.reservationId) } catch { /* adaptive control is advisory to the scheduler */ }
          }
        }
      }
      aggregate.succeeded.push(...result.succeeded); aggregate.failed.push(...result.failed); aggregate.blocked.push(...result.blocked)
      if (!result.started.length) break
    }
    const finalPlan = this.repository.getPlan(planId)
    if (finalPlan && (finalPlan.status ?? "planned") === "running" && finalPlan.workstreams.every(w => ["succeeded", "integrated", "superseded"].includes(w.status))) this.repository.transitionPlanStatus(planId, "succeeded")
    return { succeeded: aggregate.succeeded.sort(), failed: aggregate.failed.sort(), blocked: aggregate.blocked.sort() }
  }
}
