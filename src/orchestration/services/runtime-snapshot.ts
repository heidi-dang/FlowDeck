import type { OrchestrationMetrics } from "../metrics"
import type { SqliteExecutionRepository } from "../execution/sqlite-repository"
import type { SqlitePerformanceRepository } from "../performance/sqlite-repository"
export class RuntimeSnapshotService {
  constructor(private readonly execution: SqliteExecutionRepository, private readonly performance: SqlitePerformanceRepository, private readonly metrics: OrchestrationMetrics, private readonly routingMode: () => string = () => "off") {}
  get(runId?: string): Record<string, unknown> {
    const plans = runId ? this.execution.listPlansForRun(runId) : []
    const workstreams = plans.flatMap(plan => plan?.workstreams ?? [])
    const leases = runId ? this.execution.listLeases(runId) : []
    return { routingMode: this.routingMode(), activeRuns: runId ? (plans.length ? 1 : 0) : 0, executionPlans: plans.map(p => p?.planId), workstreams: { ready: workstreams.filter(w => w.status === "ready").length, running: workstreams.filter(w => w.status === "running").length, blocked: workstreams.filter(w => w.status === "blocked").length, completed: workstreams.filter(w => ["succeeded", "integrated"].includes(w.status)).length }, worktreeLeases: { active: leases.filter(l => ["allocated", "active", "renewing"].includes(l.state)).length, reclaimable: leases.filter(l => l.state === "reclaimable").length }, performance: { observations: runId ? this.performance.listObservations(runId).length : 0 }, metrics: this.metrics.snapshot().filter(m => !m.labels || Object.keys(m.labels).every(k => !["runId", "sessionId", "workstreamId", "decisionId", "sourceSha", "path", "prompt", "workspace"].includes(k))) }
  }
}
