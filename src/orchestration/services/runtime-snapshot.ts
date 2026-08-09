import type { OrchestrationMetrics } from "../metrics"
import type { SqliteExecutionRepository } from "../execution/sqlite-repository"
import type { SqlitePerformanceRepository } from "../performance/sqlite-repository"
export class RuntimeSnapshotService {
  constructor(private readonly execution: SqliteExecutionRepository, private readonly performance: SqlitePerformanceRepository, private readonly metrics: OrchestrationMetrics, private readonly routingMode: () => string = () => "off", private readonly budgetState: () => Record<string, unknown> = () => ({})) {}
  get(runId?: string): Record<string, unknown> {
    const plans = runId ? this.execution.listPlansForRun(runId) : this.execution.listPlans()
    const workstreams = plans.flatMap(plan => plan?.workstreams ?? [])
    const leases = runId ? this.execution.listLeases(runId) : this.execution.listAllLeases()
    const activeRuns = new Set(plans.filter(plan => !["succeeded", "failed", "cancelled", "superseded"].includes(plan.status ?? "planned")).map(plan => plan.runId))
    const metrics = this.metrics.snapshot(); this.metrics.assertBoundedCardinality()
    return { routingMode: this.routingMode(), activeRuns: runId ? (plans.length ? 1 : 0) : activeRuns.size, executionPlans: plans.map(p => p?.planId), workstreams: { ready: workstreams.filter(w => w.status === "ready").length, running: workstreams.filter(w => w.status === "running").length, blocked: workstreams.filter(w => w.status === "blocked").length, completed: workstreams.filter(w => ["succeeded", "integrated"].includes(w.status)).length }, worktreeLeases: { active: leases.filter(l => ["allocated", "active", "renewing"].includes(l.state)).length, reclaimable: leases.filter(l => l.state === "reclaimable").length }, budget: this.budgetState(), performance: { observations: runId ? this.performance.listObservations(runId).length : undefined }, blockers: { blockedWorkstreams: workstreams.filter(w => w.status === "blocked").length, failedPlans: plans.filter(plan => plan.status === "failed").length }, health: { persistence: true, metrics: true }, metrics: metrics.filter(m => !m.labels || Object.keys(m.labels).every(k => !["runId", "sessionId", "workstreamId", "decisionId", "sourceSha", "path", "prompt", "workspace", "worktreePath"].includes(k))) }
  }
}
