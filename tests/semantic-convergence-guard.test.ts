import { describe, it, expect } from "bun:test"
import { SemanticConvergenceGuard } from "../src/services/semantic-convergence-guard"

describe("SEMANTIC CONVERGENCE GUARD", () => {
  it("different commands with equivalent no-progress behavior are detected", () => {
    const guard = new SemanticConvergenceGuard({ maxToolCallsSinceProgress: 5, maxModelTurnsSinceProgress: 3, maxTokensSinceProgress: 60_000, maxRecoveryEventsSinceProgress: 1, maxGuardBlocksSinceProgress: 1 })
    // model burns tokens, runs tools, no progress
    guard.recordToolCall("s1"); guard.recordToolCall("s1"); guard.recordToolCall("s1"); guard.recordToolCall("s1"); guard.recordToolCall("s1")
    guard.recordModelTurn("s1", 20_000, 50); guard.recordModelTurn("s1", 20_000, 50); guard.recordModelTurn("s1", 20_000, 50)
    guard.recordGuardBlock("s1")
    const r = guard.check("s1")
    expect(r.convergent).toBe(false)
    expect(r.detectedNoProgress).toBe(true)
    expect(r.strategyAdvanceRequired).toBe(true)
  })
  it("repeated tests of unchanged source do not reset progress", () => {
    const guard = new SemanticConvergenceGuard({ maxToolCallsSinceProgress: 3, maxModelTurnsSinceProgress: 2, maxTokensSinceProgress: 10_000, maxRecoveryEventsSinceProgress: 1, maxGuardBlocksSinceProgress: 1 })
    for (let i = 0; i < 3; i++) { guard.recordToolCall("s2"); guard.recordNonProgressSignal("s2", "same_test_repeat") }
    for (let i = 0; i < 3; i++) { guard.recordModelTurn("s2", 8_000, 40) }
    const before = guard.check("s2")
    expect(before.convergent).toBe(false)
    // Now a genuine source change resets the window properly.
    guard.recordProgress("s2", "source_changed", ["src/index.ts changed"])
    const state = guard.getState("s2")!
    expect(state.meaningfulProgressEpoch).toBe(2)
    expect(state.toolCallsSinceProgress).toBe(0)
    expect(state.verifiedFacts).toContain("src/index.ts changed")
  })
  it("changed reproduction outcome resets progress correctly", () => {
    const guard = new SemanticConvergenceGuard()
    guard.recordToolCall("s3")
    guard.recordProgress("s3", "reproduction_outcome_changed")
    const state = guard.getState("s3")!
    expect(state.toolCallsSinceProgress).toBe(0)
  })
  it("healthy workload with real progress stays convergent", () => {
    const guard = new SemanticConvergenceGuard({ maxToolCallsSinceProgress: 3 })
    for (let i = 0; i < 50; i++) { guard.recordToolCall("s4"); guard.recordProgress("s4", "verification_advanced") }
    expect(guard.check("s4").convergent).toBe(true)
  })
  it("watchdog prompt and internal Continue do NOT count as progress", () => {
    const guard = new SemanticConvergenceGuard({ maxToolCallsSinceProgress: 3 })
    guard.recordNonProgressSignal("s5", "watchdog_prompt")
    guard.recordNonProgressSignal("s5", "internal_continue")
    expect(guard.getState("s5")!.toolCallsSinceProgress).toBe(0)
    expect(guard.getState("s5")!.meaningfulProgressEpoch).toBe(1)
  })
})