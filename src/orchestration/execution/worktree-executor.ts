import { randomUUID } from "node:crypto"
import type { ExecutionWorkstream } from "./contracts"
import type { SqliteExecutionRepository } from "./sqlite-repository"
import { ExecutionScheduler } from "./scheduler"
import type { GitWorktreeManager, WorktreeAllocation } from "./worktree-manager"

export interface IsolatedWorkstreamExecutor { execute(workstream: ExecutionWorkstream, allocation: WorktreeAllocation): Promise<"succeeded" | "failed"> }
export class WorktreeExecutionService {
  constructor(private readonly repository: SqliteExecutionRepository, private readonly scheduler: ExecutionScheduler, private readonly worktrees: GitWorktreeManager) {}
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
      const result = await this.scheduler.runReady(planId, { execute: async workstream => { const allocation = allocations.get(workstream.workstreamId)!; try { return await executor.execute(workstream, allocation) } finally { const lease = this.repository.listLeases(workstream.runId).find(l => l.workstreamId === workstream.workstreamId); if (lease) this.repository.releaseLease(lease.leaseId) } } })
      aggregate.succeeded.push(...result.succeeded); aggregate.failed.push(...result.failed); aggregate.blocked.push(...result.blocked)
      if (!result.started.length) break
    }
    return { succeeded: aggregate.succeeded.sort(), failed: aggregate.failed.sort(), blocked: aggregate.blocked.sort() }
  }
}
