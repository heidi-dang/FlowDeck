import { describe, expect, it, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { runMigrations } from "../src/orchestration/persistence/migrations/migration-runner"
import { HeidiParallelEngine } from "../src/services/heidi-parallel-engine"
import { InMemoryTokenUsageStore } from "../src/services/token-usage-store"
import { TokenBudgetController } from "../src/services/token-budget-controller"
import { resolveTokenBudgetConfig } from "../src/config/token-budget-config"

describe("Parallel Engine Benchmarks & Regression Suite", () => {
  let db: Database
  let engine: HeidiParallelEngine

  beforeEach(() => {
    db = new Database(":memory:")
    runMigrations(db)
    engine = new HeidiParallelEngine(db)
  })

  it("Benchmark 1: Independent read-only work speedup", async () => {
    // 6 independent read jobs with 50ms controlled latency each
    const run = engine.createRun({
      parentSessionId: "sess_b1",
      goal: "Independent read benchmark",
      nodes: Array.from({ length: 6 }, (_, i) => ({
        id: `R${i + 1}`,
        specialist: "researcher",
        goal: `read task ${i + 1}`,
        access: "read",
      })),
    })

    // Sequential timing simulation
    const seqStart = Date.now()
    for (const node of run.nodes) {
      await new Promise(r => setTimeout(r, 30))
      engine.transitionNode(node.id, "completed")
    }
    const seqDuration = Date.now() - seqStart

    // Parallel timing simulation
    const runParallel = engine.createRun({
      parentSessionId: "sess_b1_p",
      goal: "Parallel execution",
      nodes: Array.from({ length: 6 }, (_, i) => ({
        id: `PR${i + 1}`,
        specialist: "researcher",
        goal: `read task ${i + 1}`,
        access: "read",
      })),
    })

    const parStart = Date.now()
    const runnable = engine.findRunnableNodes(runParallel.runId, { configuredHardLimit: 6 })
    expect(runnable).toHaveLength(6)

    await Promise.all(
      runnable.map(async node => {
        engine.transitionNode(node.id, "running")
        await new Promise(r => setTimeout(r, 30))
        engine.transitionNode(node.id, "completed")
      })
    )
    const parDuration = Date.now() - parStart
    const speedup = seqDuration / Math.max(parDuration, 1)

    expect(speedup).toBeGreaterThanOrEqual(2.0)
  })

  it("Benchmark 2: Dependency DAG execution order", async () => {
    const run = engine.createRun({
      parentSessionId: "sess_dag",
      goal: "DAG order check",
      nodes: [
        { id: "A", specialist: "mapper", goal: "task A", access: "read" },
        { id: "B", specialist: "researcher", goal: "task B", access: "read" },
        { id: "C", specialist: "architect", goal: "task C", access: "read" },
        { id: "D", specialist: "backend-coder", goal: "task D", dependencies: ["A"], access: "write" },
        { id: "E", specialist: "frontend-coder", goal: "task E", dependencies: ["C"], access: "write" },
        { id: "F", specialist: "tester", goal: "task F", dependencies: ["B", "D"], access: "write" },
      ],
    })

    // Wave 1
    const wave1 = engine.findRunnableNodes(run.runId).map(n => n.id).sort()
    expect(wave1).toEqual(["A", "B", "C"])

    // Complete A and C
    engine.transitionNode("A", "running")
    engine.transitionNode("C", "running")
    engine.transitionNode("A", "completed")
    engine.transitionNode("C", "completed")

    // Immediately unblock D and E even though B is still queued/running
    const wave2 = engine.findRunnableNodes(run.runId).map(n => n.id).sort()
    expect(wave2).toContain("D")
    expect(wave2).toContain("E")
    expect(wave2).not.toContain("F") // F needs B and D

    // Complete B and D
    engine.transitionNode("B", "running")
    engine.transitionNode("D", "running")
    engine.transitionNode("B", "completed")
    engine.transitionNode("D", "completed")

    const wave3 = engine.findRunnableNodes(run.runId).map(n => n.id)
    expect(wave3).toContain("F")
  })

  it("Benchmark 3: Failure isolation", () => {
    const run = engine.createRun({
      parentSessionId: "sess_fail",
      goal: "Failure isolation check",
      nodes: [
        { id: "N1", specialist: "researcher", goal: "fails", access: "read" },
        { id: "N2", specialist: "mapper", goal: "independent", access: "read" },
        { id: "N3", specialist: "backend-coder", goal: "depends on N1", dependencies: ["N1"], access: "write" },
        { id: "N4", specialist: "frontend-coder", goal: "depends on N2", dependencies: ["N2"], access: "write" },
      ],
    })

    engine.transitionNode("N1", "running")
    engine.transitionNode("N2", "running")
    engine.transitionNode("N1", "failed", { error: "Network timeout" })
    engine.transitionNode("N2", "completed", { summary: "Done" })

    const runnable = engine.findRunnableNodes(run.runId).map(n => n.id)
    expect(runnable).toEqual(["N4"])

    const updatedRun = engine.getRun(run.runId)!
    const n3 = updatedRun.nodes.find(n => n.id === "N3")!
    expect(n3.status).toBe("blocked")
  })

  it("Benchmark 4: Restart durability", () => {
    const run = engine.createRun({
      parentSessionId: "sess_restart",
      goal: "Restart durability check",
      nodes: [
        { id: "C1", specialist: "mapper", goal: "done task", access: "read" },
        { id: "R1", specialist: "researcher", goal: "running read", access: "read" },
        { id: "W1", specialist: "backend-coder", goal: "running write", access: "write" },
        { id: "Q1", specialist: "tester", goal: "queued task", dependencies: ["C1"], access: "read" },
      ],
    })

    engine.transitionNode("C1", "running")
    engine.transitionNode("C1", "completed")
    engine.transitionNode("R1", "running")
    engine.transitionNode("W1", "running")

    // Simulate restart
    const recovery = engine.recoverOnRestart()
    expect(recovery.recoveredRuns).toBe(1)

    const recoveredRun = engine.getRun(run.runId)!
    expect(recoveredRun.nodes.find(n => n.id === "C1")!.status).toBe("completed")
    expect(recoveredRun.nodes.find(n => n.id === "R1")!.status).toBe("queued")
    expect(recoveredRun.nodes.find(n => n.id === "W1")!.status).toBe("blocked")

    const runnable = engine.findRunnableNodes(run.runId).map(n => n.id)
    expect(runnable).toContain("Q1")
    expect(runnable).toContain("R1")
  })

  it("Benchmark 5: Token budget ceiling under adversarial parallel reservation", async () => {
    const store = new InMemoryTokenUsageStore()
    const config = resolveTokenBudgetConfig({
      enabled: true,
      profile: "small",
      runTotal: 10000,
      childTotal: 2000,
      warningThreshold: 0.8,
      hardStopThreshold: 1.0,
    })
    const controller = new TokenBudgetController(config, { store, runId: "run_adv" })

    // Simulate 6 parallel child reservation attempts concurrently
    const promises = Array.from({ length: 6 }, (_, i) =>
      controller.reserveRequest({
        runId: "run_adv",
        sessionId: `sess_child_${i}`,
        agentId: "specialist",
        parentSessionId: "sess_parent",
        requestId: `req_${i}`,
        estimatedInputTokens: 1000,
        maxOutputTokens: 1000,
      })
    )

    const results = await Promise.all(promises)
    const allowedCount = results.filter(r => r.allowed).length

    expect(allowedCount).toBe(5) // 5 * 2000 = 10000 claimed
  })

  it("Benchmark 6: Conflicting writers serialization & review", () => {
    const run = engine.createRun({
      parentSessionId: "sess_conflict",
      goal: "Conflicting write scopes",
      nodes: [
        { id: "W1", specialist: "backend-coder", goal: "modify API", access: "write", fileScopes: ["src/api/v1.ts"] },
        { id: "W2", specialist: "devops", goal: "modify API config", access: "write", fileScopes: ["src/api/v1.ts"] },
      ],
    })

    const runnableInitial = engine.findRunnableNodes(run.runId, { configuredHardLimit: 2 })
    expect(runnableInitial).toHaveLength(1)
    expect(runnableInitial[0].id).toBe("W1")

    engine.transitionNode("W1", "running")

    // While W1 is running, W2 cannot be dispatched
    expect(engine.findRunnableNodes(run.runId)).toHaveLength(0)

    engine.transitionNode("W1", "completed")

    // After W1 completes, W2 becomes runnable
    const runnableAfter = engine.findRunnableNodes(run.runId)
    expect(runnableAfter).toHaveLength(1)
    expect(runnableAfter[0].id).toBe("W2")
  })
})
