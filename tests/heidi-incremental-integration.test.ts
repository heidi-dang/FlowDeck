import { describe, it, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { runMigrations } from "../src/orchestration/persistence/migrations/migration-runner"
import { HeidiParallelEngine } from "../src/services/heidi-parallel-engine"

describe("INCREMENTAL INTEGRATION (engine + lifecycle)", () => {
  it("execution completed does NOT imply integration; siblings stay running; READY result integrates before final convergence", () => {
    const db = new Database(":memory:")
    runMigrations(db)
    const engine = new HeidiParallelEngine(db, { enabled: true, maxChildren: 4, defaultTarget: 4, maxWriteChildren: 3, childTimeoutMs: 600000, retryLimit: 1, adaptive: true })
    const run = engine.createRun({
      parentSessionId: "s1", goal: "audit",
      nodes: [
        { id: "A", specialist: "security-auditor", goal: "audit fdx", access: "write", fileScopes: ["src/services/fdx/"] },
        { id: "B", specialist: "reviewer", goal: "review", access: "write", fileScopes: ["src/services/audit/"] },
        { id: "C", specialist: "architect", goal: "arch", access: "write", fileScopes: ["src/services/ok/"] },
        { id: "D", specialist: "tester", goal: "test", access: "write", fileScopes: ["src/services/score/"] },
      ],
    })
    const nodeIds = ["A", "B", "C", "D"]
    for (const n of nodeIds) engine.transitionNode(n, "running")

    // B completes early with a valid ChildResult: execution status completed, integration ready.
    engine.transitionNode("B", "completed", { result: { delegationId: "B", status: "completed", summary: "ok", verifiedFacts: ["x"], changedFiles: ["src/services/audit/"], artifacts: [], tests: [], blockers: [] } })
    engine.setIntegrationStatus("B", "ready", { resultReadyAt: Date.now() })

    const ready = engine.readyResults(run.runId)
    expect(ready.map((n) => n.id)).toContain("B")

    // A/C/D remain running: the whole run is NOT terminal and the result is NOT yet integrated.
    const runAfter = engine.getRun(run.runId)!
    expect(["A","C","D"].every((n) => runAfter.nodes.find((x) => x.id === n)!.status === "running")).toBe(true)
    expect(engine.getIntegrationStatus("B")!.status).toBe("ready")

    // Integrate B while others run.
    engine.setIntegrationStatus("B", "integrating")
    engine.setIntegrationStatus("B", "focused_verification")
    engine.setIntegrationStatus("B", "integrated")
    expect(engine.readyResults(run.runId).map((n) => n.id)).not.toContain("B")

  })
})
