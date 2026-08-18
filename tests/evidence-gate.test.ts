import { describe, it, expect } from "bun:test"
import { evaluateEvidenceGate, requireLiveEvidence, EVIDENCE_AUTHORITY } from "../src/services/evidence-gate"

describe("EVIDENCE-GATED RESOLUTION", () => {
  it("unit test PASS + live reproduction FAIL => OPEN (lower authority cannot override)", () => {
    const gate = requireLiveEvidence("HEIDI-77", [
      { kind: "unit_regression_test", id: "t1", outcome: "PASS", at: Date.now() },
      { kind: "live_reproduction", id: "live", outcome: "FAIL", at: Date.now() },
    ])
    expect(gate.status).toBe("OPEN")
    expect(gate.resolutionAllowed).toBe(false)
    expect(gate.highestAuthorityOutcome).toBe("FAIL")
  })
  it("model says resolved + acceptance FAIL => OPEN", () => {
    const gate = evaluateEvidenceGate({ taskId: "t", requiredKind: "focused_acceptance_test", evidence: [
      { kind: "model_assertion", id: "m", outcome: "PASS", at: Date.now() },
      { kind: "focused_acceptance_test", id: "a", outcome: "FAIL", at: Date.now() },
    ] })
    expect(gate.status).toBe("OPEN")
  })
  it("all required evidence PASS => RESOLVED", () => {
    const gate = requireLiveEvidence("t", [
      { kind: "unit_regression_test", id: "u", outcome: "PASS", at: Date.now() },
      { kind: "focused_acceptance_test", id: "a", outcome: "PASS", at: Date.now() },
      { kind: "live_reproduction", id: "live", outcome: "PASS", at: Date.now() },
    ])
    expect(gate.status).toBe("RESOLVED")
    expect(gate.resolutionAllowed).toBe(true)
  })
  it("authority ordering is validated", () => {
    expect(EVIDENCE_AUTHORITY.live_reproduction).toBe(5)
    expect(EVIDENCE_AUTHORITY.integration_runtime_contract).toBe(4)
    expect(EVIDENCE_AUTHORITY.focused_acceptance_test).toBe(3)
    expect(EVIDENCE_AUTHORITY.unit_regression_test).toBe(2)
    expect(EVIDENCE_AUTHORITY.model_assertion).toBe(1)
  })
})