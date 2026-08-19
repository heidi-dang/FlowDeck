/**
 * Unit & Integration Tests for Active Parallel Coordinator & Incremental Integration
 */

import { describe, it, expect } from "bun:test"
import { HeidiActiveCoordinator } from "../src/services/heidi-active-coordinator"

describe("Active Parallel Coordinator Lifecycle & Directives", () => {
  it("rotates coordinator useful work while children are running and no results are ready", () => {
    const parentSessionId = "ses_root_coord_test"
    const coordinator = new HeidiActiveCoordinator({
      parentSessionId,
      runId: "par_test_run",
      goal: "Test active coordinator goal",
      coordinatorOwnership: {
        integrationScopes: ["src/index.ts", "tests/"],
        readScopes: ["src/**"],
      },
      children: [
        { workstreamId: "ws_debug", specialist: "debug-specialist", goal: "audit recovery", access: "write", fileScopes: ["src/services/recovery*.ts"] },
        { workstreamId: "ws_arch", specialist: "architect", goal: "audit architecture", access: "write", fileScopes: ["src/services/dsh*.ts"] },
      ],
    })

    // Mark children started
    coordinator.recordChildLifecycleEvent({
      childId: "ws_debug",
      kind: "child.started",
      snapshot: {
        childId: "ws_debug",
        parentSessionId,
        specialist: "debug-specialist",
        state: "running",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    })
    coordinator.recordChildLifecycleEvent({
      childId: "ws_arch",
      kind: "child.started",
      snapshot: {
        childId: "ws_arch",
        parentSessionId,
        specialist: "architect",
        state: "running",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    })

    // Root coordinator requests directive while children are running
    const directive1 = coordinator.nextCoordinatorDirective()
    expect(directive1.kind).toBe("coordinator_work")
    expect(coordinator.getPhase()).toBe("coordinator_active")

    const metrics = coordinator.metricsSnapshot()
    expect(metrics.parallelWorkersStarted).toBe(2)
    expect(metrics.coordinatorUsefulWorkMs).toBeGreaterThanOrEqual(1)
  })

  it("prioritizes incremental integration immediately when first child completes before others", () => {
    const parentSessionId = "ses_root_incr_test"
    const coordinator = new HeidiActiveCoordinator({
      parentSessionId,
      runId: "par_incr_run",
      goal: "Test incremental integration",
      coordinatorOwnership: { integrationScopes: ["src/index.ts"], readScopes: ["src/**"] },
      children: [
        { workstreamId: "ws_1", specialist: "tester", goal: "run tests", access: "write", fileScopes: ["tests/unit/**"] },
        { workstreamId: "ws_2", specialist: "security-auditor", goal: "security audit", access: "write", fileScopes: ["src/security/**"] },
      ],
    })

    const t0 = 1000
    coordinator.recordChildLifecycleEvent({
      childId: "ws_1",
      kind: "child.started",
      snapshot: { childId: "ws_1", parentSessionId, specialist: "tester", state: "running", createdAt: t0, lastActivityAt: t0 },
    })
    coordinator.recordChildLifecycleEvent({
      childId: "ws_2",
      kind: "child.started",
      snapshot: { childId: "ws_2", parentSessionId, specialist: "security-auditor", state: "running", createdAt: t0, lastActivityAt: t0 },
    })

    // Child 1 completes first at t0 + 100
    const tCompleted1 = t0 + 100
    coordinator.recordChildLifecycleEvent({
      childId: "ws_1",
      kind: "child.completed",
      snapshot: {
        childId: "ws_1",
        parentSessionId,
        specialist: "tester",
        state: "completed",
        createdAt: t0,
        finishedAt: tCompleted1,
        lastActivityAt: tCompleted1,
        summary: "Tester finished unit checks",
      },
    })

    // Next directive MUST be integrate_ready for child 1 while child 2 is still running
    const directive = coordinator.nextCoordinatorDirective()
    expect(directive.kind).toBe("integrate_ready")
    expect(directive.nodeId).toBe("ws_1")
    expect(coordinator.getPhase()).toBe("incremental_integration")

    // Mark child 1 integrating and integrated
    coordinator.markIntegrating("ws_1")
    coordinator.markIntegrated("ws_1")

    // Child 2 is still running; coordinator resumes coordinator_work
    const nextDir = coordinator.nextCoordinatorDirective()
    expect(nextDir.kind).toBe("coordinator_work")

    // Child 2 completes at t0 + 300
    const tCompleted2 = t0 + 300
    coordinator.recordChildLifecycleEvent({
      childId: "ws_2",
      kind: "child.completed",
      snapshot: {
        childId: "ws_2",
        parentSessionId,
        specialist: "security-auditor",
        state: "completed",
        createdAt: t0,
        finishedAt: tCompleted2,
        lastActivityAt: tCompleted2,
      },
    })

    // Child 2 integrates
    const dir2 = coordinator.nextCoordinatorDirective()
    expect(dir2.kind).toBe("integrate_ready")
    expect(dir2.nodeId).toBe("ws_2")
    coordinator.markIntegrating("ws_2")
    coordinator.markIntegrated("ws_2")

    // All children integrated -> final convergence
    expect(coordinator.shouldEnterFinalConvergence()).toBe(true)

    // Verify metrics: firstChildReadyAt, firstChildIntegratedAt, lastChildCompletedAt
    const m = coordinator.metricsSnapshot()
    expect(m.firstChildReadyAt).toBe(tCompleted1)
    expect(m.firstChildIntegratedAt).toBeGreaterThanOrEqual(tCompleted1)
    expect(m.lastChildCompletedAt).toBe(tCompleted2)
    expect(m.firstChildIntegratedAt).toBeLessThanOrEqual(m.lastChildCompletedAt)
  })

  it("computes exact coordinator useful work ratio, idle tracking, and missed ready results", () => {
    const parentSessionId = "ses_metrics_comp_test"
    const coordinator = new HeidiActiveCoordinator({
      parentSessionId,
      runId: "par_metrics_run",
      goal: "Test metrics computation",
      coordinatorOwnership: { integrationScopes: ["src/index.ts"], readScopes: ["src/**"] },
      children: [
        { workstreamId: "ws_a", specialist: "tester", goal: "test a", access: "write", fileScopes: ["tests/a/**"] },
        { workstreamId: "ws_b", specialist: "reviewer", goal: "review b", access: "write", fileScopes: ["src/b/**"] },
      ],
    })

    // 1. Mark both launched and running
    coordinator.markLaunched("ws_a")
    coordinator.markLaunched("ws_b")
    coordinator.reconcileChildren([
      { childId: "ws_a", parentSessionId, specialist: "tester", state: "running" as any, createdAt: 100, lastActivityAt: 100 },
      { childId: "ws_b", parentSessionId, specialist: "reviewer", state: "running" as any, createdAt: 100, lastActivityAt: 100 },
    ])

    // Coordinator work is issued while children active
    const dir1 = coordinator.nextCoordinatorDirective()
    expect(dir1.kind).toBe("coordinator_work")

    // Record useful work time manually
    coordinator.recordCoordinatorWork(150)
    coordinator.recordCoordinatorIdle(50)

    let snap = coordinator.metricsSnapshot()
    expect(snap.coordinatorUsefulWorkMs).toBeGreaterThanOrEqual(150)
    expect(snap.coordinatorIdleWhileChildrenActiveMs).toBe(50)
    expect(snap.coordinatorUsefulWorkRatio).toBeCloseTo(snap.coordinatorUsefulWorkMs / (snap.coordinatorUsefulWorkMs + 50), 2)

    // Child A completes -> ready queue
    coordinator.recordChildLifecycleEvent({
      childId: "ws_a",
      kind: "child.completed",
      snapshot: { childId: "ws_a", parentSessionId, specialist: "tester", state: "completed" as any, createdAt: 100, finishedAt: 200, lastActivityAt: 200 },
    })

    // Ready result sitting unintegrated while coordinator does non-integration work counts as missed ready result check
    expect(coordinator.getReadyResults()).toContain("ws_a")
    const readyDir = coordinator.nextCoordinatorDirective()
    expect(readyDir.kind).toBe("integrate_ready")
    expect(readyDir.nodeId).toBe("ws_a")

    // Enter final convergence with active children triggers awaitAllBarrierMs
    coordinator.enterFinalConvergence()
    snap = coordinator.metricsSnapshot()
    expect(snap.awaitAllBarrierMs).toBeGreaterThan(0)
  })
})
