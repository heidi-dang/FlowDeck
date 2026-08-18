import { describe, it, expect } from "bun:test"
import { RuntimeSelfAudit, buildLatencyBreakdown } from "../src/services/runtime-self-audit"

describe("RUNTIME SELF-AUDIT / INTEGRITY SCORE", () => {
  it("every runtime event gets a score, confidence, dimensions, evidence and latency breakdown", () => {
    const audit = new RuntimeSelfAudit()
    const ev = audit.scoreEvent({
      category: "fdx_search",
      operation: "fdx-search recovery",
      sessionID: "s1",
      dimensionScores: { execution: 100, routing: 100, governance: 100, efficiency: 100, integrity: 100 },
      evidenceIds: ["e1"],
      latencyBreakdown: buildLatencyBreakdown([["routing", 0.04], ["execution", 3.7], ["post", 0.5]]),
    })
    expect(ev.score).toBe(100)
    expect(ev.confidence).toBeGreaterThan(0)
    expect(ev.dimensions.execution).toBe(100)
    expect(ev.evidenceIds).toContain("e1")
    expect(ev.latencyBreakdown.length).toBeGreaterThanOrEqual(1)
  })
  it("critical failure caps the score (averaging cannot hide catastrophic failure)", () => {
    const audit = new RuntimeSelfAudit()
    const ev = audit.scoreEvent({
      category: "task_delegation",
      operation: "delegate",
      sessionID: "s2",
      dimensionScores: { execution: 100, routing: 100, governance: 100 },
      evidenceIds: [],
      latencyBreakdown: [],
      violations: [{ code: "FALSE_DELEGATION_BLOCK", severity: "severe", detail: "root Heidi depth 1" }],
    })
    // 100 average but the severe cap forces the score down to 20.
    expect(ev.score).toBeLessThanOrEqual(20)
    // Session Integrity retains historical degradation.
    const integ = audit.sessionIntegrity("s2")
    expect(integ.severeCount).toBe(1)
    expect(integ.score).toBeLessThan(100)
    // Current Health can still recover after a later healthy event.
    audit.scoreEvent({ category: "fdx_search", operation: "s", sessionID: "s2", dimensionScores: { execution: 100, governance: 100 }, evidenceIds: [], latencyBreakdown: [] })
    expect(audit.currentHealth("s2").score).toBeGreaterThan(0)
  })
  it("runtime crash => near-zero event score", () => {
    const audit = new RuntimeSelfAudit()
    const ev = audit.scoreEvent({
      category: "tool_execution",
      operation: "bash",
      sessionID: "s3",
      dimensionScores: { execution: 60 },
      evidenceIds: [],
      latencyBreakdown: [],
      violations: [{ code: "RUNTIME_CRASH", severity: "fatal", detail: "plugin crashed" }],
    })
    expect(ev.score).toBeLessThanOrEqual(5)
    expect(audit.sessionIntegrity("s3").fatalCount).toBe(1)
  })
  it("low scores are explainable; hidden reasoning never stored", () => {
    const audit = new RuntimeSelfAudit()
    const ev = audit.scoreEvent({
      category: "task_delegation",
      operation: "delegate",
      sessionID: "s4",
      dimensionScores: { execution: 100, routing: 100, governance: 100, state_consistency: 0 },
      evidenceIds: [],
      latencyBreakdown: [],
      // Think/reasoning metadata only — never reasoning text.
      reasoningMeta: { durationMs: 120, terminalState: "stop", visibleOutputPresent: false, malformedCompletion: true, recoveryRequired: true },
    })
    ev.criticalViolations.push({ code: "SESSION_ANCESTRY_CORRUPTION", severity: "severe", detail: "root Heidi depth 1" })
    expect(audit.explain(ev.id)).toContain("SESSION_ANCESTRY_CORRUPTION")
    // No chain-of-thought fields exist anywhere in the event.
    expect(JSON.stringify(ev)).not.toContain("chainOfThought")
    expect(JSON.stringify(ev)).not.toContain("reasoningText")
  })
  it("self-audit is deterministic and cheap (no model call)", () => {
    const audit = new RuntimeSelfAudit()
    const t0 = performance.now()
    for (let i = 0; i < 500; i++) {
      audit.scoreEvent({ category: "think", operation: "think", sessionID: "s5", dimensionScores: { execution: 100 }, evidenceIds: [], latencyBreakdown: [] })
    }
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(2000)
    expect(audit.recentEvents(undefined, 500).length).toBe(500)
  })
  it("session integrity is strictly session-scoped; globalIntegrity sees all sessions", () => {
    const audit = new RuntimeSelfAudit()
    // Session A gets a severe incident.
    audit.scoreEvent({
      category: "task_delegation",
      operation: "delegate",
      sessionID: "A",
      dimensionScores: { execution: 100, governance: 100 },
      evidenceIds: [],
      latencyBreakdown: [],
      violations: [{ code: "FALSE_DELEGATION_BLOCK", severity: "severe", detail: "blocked" }],
    })
    // Session B has only healthy events.
    audit.scoreEvent({ category: "fdx_search", operation: "read", sessionID: "B", dimensionScores: { execution: 100, governance: 100 }, evidenceIds: [], latencyBreakdown: [] })

    // A's incident drops A...
    const integA = audit.sessionIntegrity("A")
    expect(integA.severeCount).toBe(1)
    expect(integA.incidents).toBe(1)
    expect(integA.score).toBeLessThan(100)

    // ...but leaves session B untouched at 100.
    const integB = audit.sessionIntegrity("B")
    expect(integB.severeCount).toBe(0)
    expect(integB.incidents).toBe(0)
    expect(integB.score).toBe(100)

    // Global integrity aggregates all incidents and reports both sessions.
    const global = audit.globalIntegrity()
    expect(global.severeCount).toBe(1)
    expect(global.incidents).toBe(1)
    expect(global.score).toBeLessThan(100)
    // sessions = the sessions that actually hold incidents on the ledger.
    // A holds the severe incident; B (healthy only) does not.
    expect(global.sessions).toContain("A")
    expect(global.sessions).not.toContain("B")
  })
})
