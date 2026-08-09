import { randomUUID } from "node:crypto"
import type { ExecutionWorkstream } from "./contracts"
import type { SqliteExecutionRepository } from "./sqlite-repository"
import { ExecutionScheduler } from "./scheduler"
import type { GitWorktreeManager, WorktreeAllocation } from "./worktree-manager"

export interface IsolatedWorkstreamExecutor { execute(workstream: ExecutionWorkstream, allocation: WorktreeAllocation): Promise<"succeeded" | "failed"> }
export interface IntegrationCoordinator { integrate(workstream: ExecutionWorkstream, sourceSha: string, branch: string, workspace: string): void; currentSourceSha?: () => string }
export class WorktreeExecutionService {
  constructor(private readonly repository: SqliteExecutionRepository, private readonly scheduler: ExecutionScheduler, private readonly worktrees: GitWorktreeManager, private readonly integration?: IntegrationCoordinator) {}
  async executePlan(planId: string, sourceSha: string, executor: IsolatedWorkstreamExecutor): Promise<{ succeeded: string[]; failed: string[]; blocked: string[] }> {
    const aggregate = { succeeded: [] as string[], failed: [] as string[], blocked: [] as string[] }
    for (let wave = 0; wave < 100; wave++) {
      const ready = this.repository.listReady(planId); if (!ready.length) break
      const allocations = new Map<string, WorktreeAllocation>()
      for (const workstream of ready) {
        const allocation = this.worktrees.allocate(workstream.runId, workstream.workstreamId, sourceSha)
        this.repository.bindWorktree(planId, workstream.workstreamId, allocation.worktreeId, allocation.branch)
        this.repository.acquireLease({ leaseId: randomUUID(), runId: workstream.runId, planId, workstreamId: workstream.workstreamId, agentId: workstream.resolvedAgent, worktreeId: allocation.worktreeId, workspace: allocation.workspace, branch: allocation.branch, acquiredAt: new Date().toISOString(), renewedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() })
        allocations.set(workstream.workstreamId, allocation)
      }
      const result = await this.scheduler.runReady(planId, { execute: async workstream => { const allocation = allocations.get(workstream.workstreamId)!; return executor.execute(workstream, allocation) } })
      for (const workstreamId of [...result.succeeded].sort()) {
        const allocation = allocations.get(workstreamId)!
        try {
          const workstream = this.repository.getPlan(planId)!.workstreams.find(w => w.workstreamId === workstreamId)!
          if (this.integration) this.integration.integrate(workstream, this.integration.currentSourceSha?.() ?? sourceSha, allocation.branch, allocation.workspace)
        } catch {
          const current = this.repository.getPlan(planId)!.workstreams.find(w => w.workstreamId === workstreamId)!
          if (current.status === "succeeded") {
            this.repository.transitionWorkstream(planId, workstreamId, "integration_pending")
            this.repository.transitionWorkstream(planId, workstreamId, "failed", "INTEGRATION_FAILED")
          }
          result.succeeded = result.succeeded.filter(id => id !== workstreamId)
          result.failed.push(workstreamId)
        }
      }
      for (const [workstreamId, allocation] of allocations) {
        const lease = this.repository.listLeases(this.repository.getPlan(planId)!.runId).find(l => l.workstreamId === workstreamId && ["allocated", "active", "renewing"].includes(l.state))
        if (lease) this.repository.releaseLease(lease.leaseId)
        try { this.worktrees.remove(allocation) } catch { /* cleanup is recoverable through lease/worktree reconciliation */ }
      }
      aggregate.succeeded.push(...result.succeeded); aggregate.failed.push(...result.failed); aggregate.blocked.push(...result.blocked)
      if (!result.started.length) break
    }
    const finalPlan = this.repository.getPlan(planId)
    if (finalPlan && (finalPlan.status ?? "planned") === "running" && finalPlan.workstreams.every(w => ["succeeded", "integrated", "superseded"].includes(w.status))) this.repository.transitionPlanStatus(planId, "succeeded")
    return { succeeded: aggregate.succeeded.sort(), failed: aggregate.failed.sort(), blocked: aggregate.blocked.sort() }
  }
}
