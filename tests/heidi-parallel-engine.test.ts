import { describe, expect, it, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { runMigrations } from "../src/orchestration/persistence/migrations/migration-runner"
import { HeidiParallelEngine } from "../src/services/heidi-parallel-engine"

describe("HeidiParallelEngine", () => {
  let db: Database
  let engine: HeidiParallelEngine

  beforeEach(() => {
    db = new Database(":memory:")
    runMigrations(db)
    engine = new HeidiParallelEngine(db)
  })

  it("creates a valid DAG run and identifies runnable nodes", () => {
    const run = engine.createRun({
      parentSessionId: "session_123",
      goal: "Build parallel feature",
      nodes: [
        { id: "A", specialist: "mapper", goal: "map auth", access: "read" },
        { id: "B", specialist: "researcher", goal: "research API", access: "read" },
        { id: "C", specialist: "backend-coder", goal: "implement API", dependencies: ["A"], access: "write", fileScopes: ["src/api/auth.ts"] },
      ],
    })

    expect(run.runId).toBeDefined()
    expect(run.nodes).toHaveLength(3)

    const runnable = engine.findRunnableNodes(run.runId)
    const runnableIds = runnable.map(n => n.id).sort()
    expect(runnableIds).toEqual(["A", "B"])
  })

  it("rejects cycles in dependency graph", () => {
    expect(() => {
      engine.createRun({
        parentSessionId: "session_123",
        goal: "Cycle test",
        nodes: [
          { id: "A", specialist: "mapper", goal: "goal A", dependencies: ["B"] },
          { id: "B", specialist: "researcher", goal: "goal B", dependencies: ["A"] },
        ],
      })
    }).toThrow(/INVALID_DAG_CYCLE/)
  })

  it("prevents conflicting write nodes from running simultaneously", () => {
    const run = engine.createRun({
      parentSessionId: "session_123",
      goal: "Write conflict test",
      nodes: [
        { id: "W1", specialist: "backend-coder", goal: "edit file", access: "write", fileScopes: ["src/user.ts"] },
        { id: "W2", specialist: "frontend-coder", goal: "edit same file", access: "write", fileScopes: ["src/user.ts"] },
      ],
    })

    const runnableFirst = engine.findRunnableNodes(run.runId, { configuredHardLimit: 2 })
    expect(runnableFirst).toHaveLength(1)
    expect(runnableFirst[0].id).toBe("W1")

    // Transition W1 to running
    engine.transitionNode("W1", "running")

    // W2 should not be runnable due to scope conflict
    const runnableSecond = engine.findRunnableNodes(run.runId, { configuredHardLimit: 2 })
    expect(runnableSecond).toHaveLength(0)
  })

  it("unblocks dependent node immediately when prerequisite completes", () => {
    const run = engine.createRun({
      parentSessionId: "session_123",
      goal: "Dependency unblock test",
      nodes: [
        { id: "A", specialist: "mapper", goal: "map core", access: "read" },
        { id: "B", specialist: "backend-coder", goal: "build service", dependencies: ["A"], access: "write" },
      ],
    })

    expect(engine.findRunnableNodes(run.runId).map(n => n.id)).toEqual(["A"])

    engine.transitionNode("A", "running")
    engine.transitionNode("A", "completed", { summary: "Map completed" })

    expect(engine.findRunnableNodes(run.runId).map(n => n.id)).toEqual(["B"])
  })

  it("handles restart recovery by safely re-queuing read nodes and blocking unverified write nodes", () => {
    const run = engine.createRun({
      parentSessionId: "session_123",
      goal: "Restart test",
      nodes: [
        { id: "R1", specialist: "researcher", goal: "read doc", access: "read" },
        { id: "W1", specialist: "backend-coder", goal: "write code", access: "write" },
      ],
    })

    engine.transitionNode("R1", "running")
    engine.transitionNode("W1", "running")

    const recovery = engine.recoverOnRestart()
    expect(recovery.recoveredRuns).toBe(1)
    expect(recovery.resumedNodes).toContain("R1")
    expect(recovery.orphanedNodes).toContain("W1")

    const updatedRun = engine.getRun(run.runId)!
    const nodeR1 = updatedRun.nodes.find(n => n.id === "R1")!
    const nodeW1 = updatedRun.nodes.find(n => n.id === "W1")!

    expect(nodeR1.status).toBe("queued")
    expect(nodeW1.status).toBe("blocked")
  })

  it("handles transitionNode errors safely with proper rollback", () => {
    expect(() => {
      engine.transitionNode("NONEXISTENT_NODE", "running")
    }).toThrow(/NODE_NOT_FOUND/)
  })

  it("detects corrupted DB columns and fails with descriptive diagnostics", () => {
    const run = engine.createRun({
      parentSessionId: "session_123",
      goal: "Corruption test",
      nodes: [
        { id: "C1", specialist: "mapper", goal: "corrupt test", access: "read" },
      ],
    })

    // Corrupt dependencies column in DB manually
    db.query("UPDATE heidi_delegation_nodes SET dependencies = 'INVALID_JSON{' WHERE id = 'C1'").run()

    expect(() => {
      engine.getRun(run.runId)
    }).toThrow(/PARALLEL_ENGINE_DATA_CORRUPTION/)
  })
})
