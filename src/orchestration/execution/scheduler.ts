import type { ExecutionWorkstream } from "./contracts"
import { SqliteExecutionRepository } from "./sqlite-repository"
import type { OrchestrationMetrics } from "../metrics"

export interface WorkstreamExecutor { execute(workstream: ExecutionWorkstream): Promise<"succeeded" | "failed"> }
export interface SchedulerResult { started: string[]; succeeded: string[]; failed: string[]; blocked: string[] }

/** Deterministic wave scheduler. Dispatch is injected so production can bind the existing agent/session runtime. */
export class ExecutionScheduler {
  constructor(private readonly repository: SqliteExecutionRepository, private readonly metrics?: OrchestrationMetrics) {}
  async runReady(planId: string, executor: WorkstreamExecutor): Promise<SchedulerResult> {
    const started: string[] = []; const succeeded: string[] = []; const failed: string[] = []; const blocked: string[] = []
    const currentPlan = this.repository.getPlan(planId)
    if (!currentPlan) throw new Error("EXECUTION_PLAN_NOT_FOUND")
    if ((currentPlan.status ?? "planned") === "planned") this.repository.transitionPlanStatus(planId, "running")
    const ready = this.repository.listReady(planId)
    for (const workstream of ready) {
      this.repository.transitionWorkstream(planId, workstream.workstreamId, "ready")
    }
    const dispatchable = this.repository.listReady(planId)
    const outcomes = await Promise.all(dispatchable.map(async workstream => {
      this.repository.transitionWorkstream(planId, workstream.workstreamId, "running"); started.push(workstream.workstreamId); this.metrics?.workstreamsStarted.inc()
      try { return { id: workstream.workstreamId, outcome: await executor.execute(workstream) } } catch { return { id: workstream.workstreamId, outcome: "failed" as const } }
    }))
    for (const result of outcomes.sort((a, b) => a.id.localeCompare(b.id))) {
      if (result.outcome === "succeeded") { this.repository.transitionWorkstream(planId, result.id, "succeeded"); succeeded.push(result.id); this.metrics?.workstreamsSucceeded.inc() }
      else { this.repository.transitionWorkstream(planId, result.id, "failed", "WORKSTREAM_EXECUTION_FAILED"); failed.push(result.id); this.metrics?.workstreamsFailed.inc() }
    }
    let changed = true
    while (changed) {
      changed = false
      const plan = this.repository.getPlan(planId)!
      for (const w of plan.workstreams) {
        const blockedBy = w.dependsOn.filter(dependency => ["failed", "blocked", "cancelled"].includes(plan.workstreams.find(parent => parent.workstreamId === dependency)?.status ?? ""))
        if ((w.status === "planned" || w.status === "ready") && blockedBy.length) {
          this.repository.transitionWorkstream(planId, w.workstreamId, "blocked", "DEPENDENCY_FAILED", blockedBy)
          blocked.push(w.workstreamId); this.metrics?.workstreamsBlocked.inc(); this.metrics?.dependencyBlocks.inc(); changed = true
        }
      }
    }
    const finalPlan = this.repository.getPlan(planId)!
    if (finalPlan.status === "running" && finalPlan.workstreams.every(w => ["succeeded", "failed", "blocked", "cancelled", "integrated", "superseded"].includes(w.status)) && finalPlan.workstreams.some(w => ["failed", "blocked", "cancelled"].includes(w.status))) this.repository.transitionPlanStatus(planId, "failed")
    return { started: started.sort(), succeeded: succeeded.sort(), failed: failed.sort(), blocked: blocked.sort() }
  }
}
