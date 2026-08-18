import { describe, it, expect } from "bun:test"
import { RuntimeSelfAudit } from "../src/services/runtime-self-audit"
import { evaluateEvidenceGate, type VerificationEvidence } from "../src/services/evidence-gate"

describe("Runtime Score Completion Gate Integration", () => {
  it("successful evidence-gated completion receives high score", () => {
    const audit = new RuntimeSelfAudit()
    const evidence: VerificationEvidence[] = [
      { kind: "unit_regression_test", id: "unit", outcome: "PASS", at: Date.now() },
      { kind: "focused_acceptance_test", id: "acc", outcome: "PASS", at: Date.now() },
      { kind: "live_reproduction", id: "live", outcome: "PASS", at: Date.now() },
    ]
    const gate = evaluateEvidenceGate({
      taskId: "task-1",
      requiredKind: "live_reproduction",
      evidence,
    })
    expect(gate.resolutionAllowed).toBe(true)

    const ev = audit.scoreEvent({
      category: "verification",
      operation: "completion",
      sessionID: "s-comp",
      dimensionScores: { completion: 98, integrity: 98 },
      evidenceIds: ["evidence-gate:pass"],
      latencyBreakdown: [],
    })
    expect(ev.score).toBeGreaterThanOrEqual(95)
  })

  it("unsupported resolution claim triggers severe penalty (max 25 cap)", () => {
    const audit = new RuntimeSelfAudit()
    const evidence: VerificationEvidence[] = [
      { kind: "unit_regression_test", id: "unit", outcome: "PASS", at: Date.now() },
      { kind: "live_reproduction", id: "live", outcome: "FAIL", at: Date.now() },
    ]
    const gate = evaluateEvidenceGate({
      taskId: "task-2",
      requiredKind: "live_reproduction",
      evidence,
    })
    expect(gate.resolutionAllowed).toBe(false)

    const ev = audit.scoreEvent({
      category: "verification",
      operation: "completion",
      sessionID: "s-comp-fail",
      dimensionScores: { completion: 100, integrity: 100 },
      evidenceIds: ["evidence-gate:fail"],
      latencyBreakdown: [],
      violations: [{ code: "UNSUPPORTED_RESOLUTION", severity: "severe", detail: "completion claim rejected" }],
    })
    expect(ev.score).toBeLessThanOrEqual(25)
  })
})
