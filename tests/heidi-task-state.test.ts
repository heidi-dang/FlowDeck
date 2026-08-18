import { describe, it, expect, beforeEach } from "bun:test"
import {
  HeidiTaskState,
  createTaskState,
  getTaskState,
  clearTaskState,
  _resetAllTaskState,
} from "../src/services/heidi-task-state"

describe("HeidiTaskState — Milestone E1", () => {
  beforeEach(() => {
    _resetAllTaskState()
  })

  it("creates a task state with correct initial values", () => {
    const state = new HeidiTaskState("task-1", "Fix the auth bug", "FAST_DIRECT")
    const snap = state.snapshot()
    expect(snap.taskId).toBe("task-1")
    expect(snap.goal).toBe("Fix the auth bug")
    expect(snap.executionClass).toBe("FAST_DIRECT")
    expect(snap.currentPhase).toBe("intake")
    expect(snap.verificationState).toBe("pending")
    expect(snap.verifiedFacts).toEqual([])
    expect(snap.changedFiles).toEqual([])
  })

  it("transitions phase correctly", () => {
    const state = new HeidiTaskState("task-2", "Goal", "STANDARD")
    state.setPhase("execute")
    expect(state.snapshot().currentPhase).toBe("execute")
  })

  it("adds verified facts without duplicates", () => {
    const state = new HeidiTaskState("task-3", "Goal", "FAST_DIRECT")
    state.addVerifiedFact("TypeScript config is correct")
    state.addVerifiedFact("TypeScript config is correct")  // duplicate
    state.addVerifiedFact("Test suite passes")
    const snap = state.snapshot()
    expect(snap.verifiedFacts).toHaveLength(2)
  })

  it("tracks changed files without duplicates", () => {
    const state = new HeidiTaskState("task-4", "Goal", "FAST_DIRECT")
    state.addChangedFile("src/auth.ts")
    state.addChangedFile("src/auth.ts")  // duplicate
    state.addChangedFile("src/session.ts")
    expect(state.snapshot().changedFiles).toHaveLength(2)
  })

  it("manages pending children lifecycle", () => {
    const state = new HeidiTaskState("task-5", "Goal", "PARALLEL_SPECIALISTS")
    state.addPendingChild("child-frontend")
    state.addPendingChild("child-backend")
    expect(state.snapshot().pendingChildren).toHaveLength(2)
    state.removePendingChild("child-frontend")
    expect(state.snapshot().pendingChildren).toEqual(["child-backend"])
  })

  it("records failed hypotheses for circuit-breaker", () => {
    const state = new HeidiTaskState("task-6", "Goal", "STANDARD")
    state.addFailedHypothesis("The bug is in auth.ts line 42")
    state.addFailedHypothesis("The bug is in session.ts")
    expect(state.snapshot().failedHypotheses).toHaveLength(2)
  })

  it("sets blocker and transitions to blocked phase", () => {
    const state = new HeidiTaskState("task-7", "Goal", "STANDARD")
    state.setBlocker("Missing API key")
    const snap = state.snapshot()
    expect(snap.currentPhase).toBe("blocked")
    expect(snap.blockers).toContain("Missing API key")
  })

  it("clears blockers", () => {
    const state = new HeidiTaskState("task-8", "Goal", "STANDARD")
    state.setBlocker("blocker-1")
    state.clearBlockers()
    expect(state.snapshot().blockers).toHaveLength(0)
  })

  it("sets verification state", () => {
    const state = new HeidiTaskState("task-9", "Goal", "FAST_DIRECT")
    state.setVerificationState("passed")
    expect(state.snapshot().verificationState).toBe("passed")
  })

  it("renderContextPacket produces compact string < 200 tokens (~800 chars)", () => {
    const state = new HeidiTaskState("task-10", "Fix the login bug", "FAST_DIRECT")
    state.setPhase("execute")
    state.addVerifiedFact("Type error is in src/auth.ts line 42")
    state.addChangedFile("src/auth.ts")
    state.setNextAction("Run focused auth tests")
    const packet = state.renderContextPacket()
    expect(packet).toContain("[TaskState]")
    expect(packet).toContain("task-10")
    expect(packet).toContain("FAST_DIRECT")
    expect(packet).toContain("execute")
    // Should be compact — < 800 chars (approx 200 tokens)
    expect(packet.length).toBeLessThan(800)
  })

  it("registry: createTaskState/getTaskState/clearTaskState lifecycle", () => {
    const state = createTaskState("reg-task", "Goal", "STANDARD")
    expect(getTaskState("reg-task")).toBe(state)
    clearTaskState("reg-task")
    expect(getTaskState("reg-task")).toBeUndefined()
  })

  it("snapshot is an independent copy", () => {
    const state = new HeidiTaskState("task-11", "Goal", "FAST_DIRECT")
    const s1 = state.snapshot()
    state.addVerifiedFact("new fact")
    const s2 = state.snapshot()
    expect(s1.verifiedFacts).toHaveLength(0)
    expect(s2.verifiedFacts).toHaveLength(1)
  })
})
