import { describe, it, expect } from "bun:test"
import { RuntimeSelfAudit } from "../src/services/runtime-self-audit"

describe("Runtime Score for Parallel Coordination", () => {
  it("healthy execution with 4 running workers and active root scores highly", () => {
    const audit = new RuntimeSelfAudit()
    const ev = audit.scoreEvent({
      category: "parallel_coordination",
      operation: "parallel_specialists",
      sessionID: "ses-par-healthy",
      dimensionScores: { execution: 99, routing: 100, governance: 100, efficiency: 98, convergence: 98 },
      evidenceIds: ["workers:4", "started:4", "overlap:true"],
      latencyBreakdown: [],
    })
    expect(ev.score).toBeGreaterThanOrEqual(95)
    expect(ev.criticalViolations).toHaveLength(0)
  })

  it("incomplete fan-out or failed child applies penalty", () => {
    const audit = new RuntimeSelfAudit()
    const ev = audit.scoreEvent({
      category: "parallel_coordination",
      operation: "child.failed",
      sessionID: "ses-par-fail",
      dimensionScores: { execution: 50, convergence: 40 },
      evidenceIds: ["coordinator:par_reviewer"],
      latencyBreakdown: [],
      violations: [{ code: "PARALLEL_CHILD_FAILED", severity: "severe", detail: "child failed" }],
    })
    expect(ev.score).toBeLessThanOrEqual(40)
  })
})
