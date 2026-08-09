import type { ExecutionWorkstream } from "./contracts"
import { SqliteExecutionRepository } from "./sqlite-repository"

export interface WorkstreamExecutor { execute(workstream: ExecutionWorkstream): Promise<"succeeded" | "failed"> }
export interface SchedulerResult { started: string[]; succeeded: string[]; failed: string[]; blocked: string[] }

/** Deterministic wave scheduler. Dispatch is injected so production can bind the existing agent/session runtime. */
export class ExecutionScheduler {
  constructor(private readonly repository: SqliteExecutionRepository) {}
  async runReady(planId: string, executor: WorkstreamExecutor): Promise<SchedulerResult> {
    const started: string[] = []; const succeeded: string[] = []; const failed: string[] = []; const blocked: string[] = []
    const ready = this.repository.listReady(planId)
    for (const workstream of ready) {
      this.repository.transitionWorkstream(planId, workstream.workstreamId, "ready")
    }
    const dispatchable = this.repository.listReady(planId)
    const outcomes = await Promise.all(dispatchable.map(async workstream => {
      this.repository.transitionWorkstream(planId, workstream.workstreamId, "running"); started.push(workstream.workstreamId)
      try { return { id: workstream.workstreamId, outcome: await executor.execute(workstream) } } catch { return { id: workstream.workstreamId, outcome: "failed" as const } }
    }))
    for (const result of outcomes.sort((a, b) => a.id.localeCompare(b.id))) {
      if (result.outcome === "succeeded") { this.repository.transitionWorkstream(planId, result.id, "succeeded"); succeeded.push(result.id) }
      else { this.repository.transitionWorkstream(planId, result.id, "failed", "WORKSTREAM_EXECUTION_FAILED"); failed.push(result.id) }
    }
    const plan = this.repository.getPlan(planId)!; const failedSet = new Set(failed)
    for (const w of plan.workstreams) if ((w.status === "planned" || w.status === "ready") && w.dependsOn.some(d => failedSet.has(d) || plan.workstreams.find(parent => parent.workstreamId === d)?.status === "failed")) { this.repository.transitionWorkstream(planId, w.workstreamId, "blocked", "DEPENDENCY_FAILED"); blocked.push(w.workstreamId) }
    return { started: started.sort(), succeeded: succeeded.sort(), failed: failed.sort(), blocked: blocked.sort() }
  }
}
