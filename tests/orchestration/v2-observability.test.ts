import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { OrchestrationMetrics } from "../../src/orchestration/metrics"
import { RuntimeSnapshotService } from "../../src/orchestration/services/runtime-snapshot"
import { SqliteExecutionRepository } from "../../src/orchestration/execution/sqlite-repository"
import { SqlitePerformanceRepository } from "../../src/orchestration/performance"
import { createTransactionManager } from "../../src/orchestration/persistence/transaction-manager"
import { runMigrations } from "../../src/orchestration/persistence/migrations/migration-runner"
import type { ExecutionPlan } from "../../src/orchestration/execution/contracts"

const plan: ExecutionPlan = { planId: "observability-plan", runId: "observability-run", routingDecisionId: "observability-decision", sourceSha: "0123456789abcdef0123456789abcdef01234567", policyVersion: "2.0.0", createdAt: "2026-08-09T00:00:00.000Z", workstreams: [{ workstreamId: "observability-workstream", runId: "observability-run", planId: "observability-plan", resolvedAgent: "backend-coder", requiredCapability: "backend", objective: "observe", requirements: ["r"], acceptanceCriteria: ["a"], ownedPaths: ["src/observability.ts"], ownedSymbols: [], dependsOn: [], strategy: "direct", budgetProfile: "small", contextScope: "owned", status: "planned", blockedBy: [], createdAt: "2026-08-09T00:00:00.000Z" }] }

describe("v2 production observability", () => {
  it("keeps routing and execution metrics bounded and exportable", () => {
    const metrics = new OrchestrationMetrics()
    metrics.recordRoutingDecision("feature", "direct", false, false, 3, "none")
    metrics.executionPlans.inc()
    metrics.recordFdx("cache")
    expect(() => metrics.assertBoundedCardinality()).not.toThrow()
    expect(metrics.toPrometheusText()).toContain("routing_decisions_total")
    expect((metrics.toOpenTelemetry().resourceMetrics as unknown[]).length).toBe(1)
    expect(metrics.snapshot().some(metric => Object.keys(metric.labels ?? {}).some(label => ["runId", "sessionId", "workstreamId", "decisionId", "sourceSha", "path", "prompt"].includes(label)))).toBe(false)
  })

  it("returns a machine-readable runtime snapshot across all persisted runs", () => {
    const db = new Database(":memory:")
    try {
      runMigrations(db)
      const metrics = new OrchestrationMetrics()
      const execution = new SqliteExecutionRepository(db, createTransactionManager(db), metrics)
      const performance = new SqlitePerformanceRepository(db, createTransactionManager(db), metrics)
      execution.savePlan(plan)
      const snapshot = new RuntimeSnapshotService(execution, performance, metrics, () => "shadow", () => ({ enabled: true, profile: "normal" })).get()
      expect(snapshot.activeRuns).toBe(1)
      expect(snapshot.executionPlans).toEqual([{ planId: "observability-plan", runId: "observability-run", status: "planned", workstreams: 1 }])
      expect(snapshot.workstreams).toEqual({ ready: 0, running: 0, blocked: 0, completed: 0 })
      expect(snapshot.routingMode).toBe("shadow")
      expect(snapshot.budget).toEqual({ enabled: true, profile: "normal" })
      expect((snapshot as { health: { fdx: unknown } }).health.fdx).toEqual({ available: false })
    } finally { db.close() }
  })
})
