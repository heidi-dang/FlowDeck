/**
 * Completion evaluation tests.
 *
 * Covers all six gates with structured pass/fail results and reasons.
 * No override logic yet — that belongs to Phase 2C.
 */

import { describe, it, expect } from "bun:test"
import { evaluateCompletion, type CompletionEvaluationInput } from "@/orchestration/completion/services/evaluation-service"
import { createGateResult, aggregateEvaluation, GATE_NAMES } from "@/orchestration/completion/domain/evaluation"
import { VerificationResult } from "@/orchestration/verification/domain/verification-result"
import { Evidence } from "@/orchestration/evidence/domain/evidence"

const CURRENT_SHA = "abc123def456"
const OLD_SHA = "oldsha789012"
const RUN_ID = "run-1"
const OTHER_RUN_ID = "run-2"

function makeResult(overrides: Record<string, unknown> = {}): VerificationResult {
  return new VerificationResult({
    id: "vr-1",
    runId: RUN_ID,
    ruleId: "rule-1",
    ruleDescription: "Test rule",
    scope: "unit",
    required: true,
    failureClass: "blocking",
    status: "passed",
    targetSha: CURRENT_SHA,
    evidenceIds: [],
    createdAt: new Date("2026-07-29T12:00:00Z"),
    ...overrides,
  })
}

function makeEvidence(overrides: Record<string, unknown> = {}): Evidence {
  return new Evidence({
    id: "ev-1",
    content: "Test evidence",
    contentType: "text/plain",
    sha: CURRENT_SHA,
    runId: RUN_ID,
    criterionIds: ["ac-1"],
    status: "current",
    createdAt: new Date("2026-07-29T12:00:00Z"),
    ...overrides,
  })
}

function makeInput(overrides: Partial<CompletionEvaluationInput> = {}): CompletionEvaluationInput {
  return {
    requiredAssignmentsComplete: true,
    currentSha: CURRENT_SHA,
    verificationResults: [
      makeResult({ id: "vr-1", ruleId: "ac-1", ruleDescription: "Critical acceptance criterion" }),
      makeResult({ id: "vr-2", ruleId: "req-1", ruleDescription: "Critical requirement" }),
    ],
    expectedRunId: RUN_ID,
    requirements: [{ id: "req-1", description: "Critical requirement", priority: "critical" }],
    acceptanceCriteria: [{ id: "ac-1", description: "Acceptance criterion", priority: "critical" }],
    evidenceItems: [makeEvidence()],
    ...overrides,
  }
}

describe("Gate 1 — Required assignments complete", () => {
  it("passes when assignments are complete", () => {
    const evaluation = evaluateCompletion(makeInput({ requiredAssignmentsComplete: true }))
    const gate = evaluation.gates.find((g) => g.gateId === "required-assignments-complete")!
    expect(gate.passed).toBe(true)
  })

  it("fails when assignments are not complete", () => {
    const evaluation = evaluateCompletion(makeInput({ requiredAssignmentsComplete: false }))
    const gate = evaluation.gates.find((g) => g.gateId === "required-assignments-complete")!
    expect(gate.passed).toBe(false)
    expect(gate.reasons).toContain("Not all required assignments are complete")
  })
})

describe("Gate 2 — Current SHA matches verification SHA", () => {
  it("passes when all results target current SHA", () => {
    const evaluation = evaluateCompletion(makeInput())
    const gate = evaluation.gates.find((g) => g.gateId === "current-sha-matches-verification")!
    expect(gate.passed).toBe(true)
  })

  it("fails when some results target stale SHA", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [
        makeResult({ targetSha: CURRENT_SHA }),
        makeResult({ id: "vr-2", ruleId: "rule-2", targetSha: OLD_SHA }),
      ],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "current-sha-matches-verification")!
    expect(gate.passed).toBe(false)
  })

  it("fails when no results target current SHA", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [makeResult({ targetSha: OLD_SHA })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "current-sha-matches-verification")!
    expect(gate.passed).toBe(false)
  })
})

describe("Gate 3 — Critical acceptance criteria passed", () => {
  it("passes when critical criteria have passing results", () => {
    const evaluation = evaluateCompletion(makeInput())
    const gate = evaluation.gates.find((g) => g.gateId === "critical-acceptance-criteria-passed")!
    expect(gate.passed).toBe(true)
  })

  it("passes trivially when no critical criteria exist", () => {
    const evaluation = evaluateCompletion(makeInput({ acceptanceCriteria: [] }))
    const gate = evaluation.gates.find((g) => g.gateId === "critical-acceptance-criteria-passed")!
    expect(gate.passed).toBe(true)
  })

  it("fails when critical criterion result is stale", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [makeResult({ targetSha: OLD_SHA })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "critical-acceptance-criteria-passed")!
    expect(gate.passed).toBe(false)
  })

  it("fails when critical criterion result has wrong run", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [makeResult({ runId: OTHER_RUN_ID })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "critical-acceptance-criteria-passed")!
    expect(gate.passed).toBe(false)
  })

  it("fails when critical criterion result is failed", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [makeResult({ status: "failed" })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "critical-acceptance-criteria-passed")!
    expect(gate.passed).toBe(false)
  })
})

describe("Gate 4 — Critical requirements verified", () => {
  it("passes when critical requirements have passing results", () => {
    const evaluation = evaluateCompletion(makeInput())
    const gate = evaluation.gates.find((g) => g.gateId === "critical-requirements-verified")!
    expect(gate.passed).toBe(true)
  })

  it("passes trivially when no critical requirements exist", () => {
    const evaluation = evaluateCompletion(makeInput({ requirements: [] }))
    const gate = evaluation.gates.find((g) => g.gateId === "critical-requirements-verified")!
    expect(gate.passed).toBe(true)
  })

  it("fails when critical requirement is stale", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [makeResult({ targetSha: OLD_SHA })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "critical-requirements-verified")!
    expect(gate.passed).toBe(false)
  })

  it("fails when critical requirement is failed", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [makeResult({ status: "failed" })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "critical-requirements-verified")!
    expect(gate.passed).toBe(false)
  })
})

describe("Gate 5 — Verification policy satisfied", () => {
  it("passes when all required rules pass", () => {
    const evaluation = evaluateCompletion(makeInput())
    const gate = evaluation.gates.find((g) => g.gateId === "verification-policy-satisfied")!
    expect(gate.passed).toBe(true)
  })

  it("fails when required rule is pending", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [makeResult({ status: "pending" })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "verification-policy-satisfied")!
    expect(gate.passed).toBe(false)
    expect(gate.reasons.some((r) => r.includes("pending"))).toBe(true)
  })

  it("fails when required rule is running", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [makeResult({ status: "running" })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "verification-policy-satisfied")!
    expect(gate.passed).toBe(false)
  })

  it("fails when required rule is skipped", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [makeResult({ status: "skipped" })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "verification-policy-satisfied")!
    expect(gate.passed).toBe(false)
    expect(gate.reasons.some((r) => r.includes("skipped"))).toBe(true)
  })

  it("fails when required rule is failed", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [makeResult({ status: "failed" })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "verification-policy-satisfied")!
    expect(gate.passed).toBe(false)
    expect(gate.reasons.some((r) => r.includes("failed"))).toBe(true)
  })

  it("fails when required rule is stale", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [makeResult({ targetSha: OLD_SHA })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "verification-policy-satisfied")!
    expect(gate.passed).toBe(false)
  })

  it("fails when required rule belongs to wrong run", () => {
    const evaluation = evaluateCompletion(makeInput({
      verificationResults: [makeResult({ runId: OTHER_RUN_ID })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "verification-policy-satisfied")!
    expect(gate.passed).toBe(false)
  })
})

describe("Gate 6 — Mandatory evidence current and SHA-matched", () => {
  it("passes when all evidence is current and SHA-matched", () => {
    const evaluation = evaluateCompletion(makeInput())
    const gate = evaluation.gates.find((g) => g.gateId === "mandatory-evidence-current")!
    expect(gate.passed).toBe(true)
  })

  it("passes when no evidence and no results reference evidence", () => {
    const evaluation = evaluateCompletion(makeInput({
      evidenceItems: [],
      verificationResults: [],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "mandatory-evidence-current")!
    expect(gate.passed).toBe(true)
  })

  it("fails when evidence has wrong SHA", () => {
    const evaluation = evaluateCompletion(makeInput({
      evidenceItems: [makeEvidence({ sha: OLD_SHA })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "mandatory-evidence-current")!
    expect(gate.passed).toBe(false)
  })

  it("fails when evidence has wrong run", () => {
    const evaluation = evaluateCompletion(makeInput({
      evidenceItems: [makeEvidence({ runId: OTHER_RUN_ID })],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "mandatory-evidence-current")!
    expect(gate.passed).toBe(false)
  })

  it("archived evidence does not fail gate when current evidence also exists", () => {
    const evidence = makeEvidence({ id: "ev-1" })
    const archivedEvidence = makeEvidence({ id: "ev-2", status: "archived" })
    const evaluation = evaluateCompletion(makeInput({
      evidenceItems: [evidence, archivedEvidence],
    }))
    const gate = evaluation.gates.find((g) => g.gateId === "mandatory-evidence-current")!
    expect(gate.passed).toBe(true)
  })
})

describe("Aggregate evaluation", () => {
  it("returns allPassed when all gates pass", () => {
    const evaluation = evaluateCompletion(makeInput())
    expect(evaluation.allPassed).toBe(true)
    expect(evaluation.passedGates).toBe(6)
    expect(evaluation.totalGates).toBe(6)
    expect(evaluation.failingGates).toHaveLength(0)
  })

  it("returns not allPassed when any gate fails", () => {
    const evaluation = evaluateCompletion(makeInput({ requiredAssignmentsComplete: false }))
    expect(evaluation.allPassed).toBe(false)
    expect(evaluation.passedGates).toBe(5)
    expect(evaluation.failingGates).toHaveLength(1)
  })

  it("reports all six gate results", () => {
    const evaluation = evaluateCompletion(makeInput())
    const gateIds = evaluation.gates.map((g) => g.gateId)
    expect(gateIds).toEqual([
      "required-assignments-complete",
      "current-sha-matches-verification",
      "critical-acceptance-criteria-passed",
      "critical-requirements-verified",
      "verification-policy-satisfied",
      "mandatory-evidence-current",
    ])
  })

  it("each gate has a human-readable name", () => {
    const evaluation = evaluateCompletion(makeInput())
    for (const gate of evaluation.gates) {
      expect(gate.gateName).toBe(GATE_NAMES[gate.gateId])
    }
  })
})

describe("Completion evaluation — structured reasons", () => {
  it("returns reasons for each failing gate", () => {
    const evaluation = evaluateCompletion(makeInput({
      requiredAssignmentsComplete: false,
      verificationResults: [makeResult({ status: "failed" })],
    }))

    const failing = evaluation.failingGates
    expect(failing.length).toBeGreaterThan(0)
    for (const gate of failing) {
      expect(gate.reasons.length).toBeGreaterThan(0)
      expect(gate.passed).toBe(false)
    }
  })

  it("passing gates have no reasons", () => {
    const evaluation = evaluateCompletion(makeInput())
    const passing = evaluation.gates.filter((g) => g.passed)
    for (const gate of passing) {
      expect(gate.reasons).toHaveLength(0)
    }
  })
})

describe("Create gate result", () => {
  it("creates a passing gate result with no reasons", () => {
    const result = createGateResult("current-sha-matches-verification", true)
    expect(result.passed).toBe(true)
    expect(result.gateName).toBe("Current SHA equals verification SHA")
    expect(result.reasons).toEqual([])
  })

  it("creates a failing gate result with reasons", () => {
    const result = createGateResult("required-assignments-complete", false, ["Not complete"])
    expect(result.passed).toBe(false)
    expect(result.reasons).toEqual(["Not complete"])
  })
})

describe("Aggregate evaluation function", () => {
  it("aggregates multiple gate results", () => {
    const g1 = createGateResult("required-assignments-complete", true)
    const g2 = createGateResult("current-sha-matches-verification", false, ["SHA mismatch"])
    const g3 = createGateResult("critical-acceptance-criteria-passed", true)

    const evaluation = aggregateEvaluation([g1, g2, g3])
    expect(evaluation.allPassed).toBe(false)
    expect(evaluation.passedGates).toBe(2)
    expect(evaluation.totalGates).toBe(3)
    expect(evaluation.failingGates).toHaveLength(1)
    expect(evaluation.failingGates[0].gateId).toBe("current-sha-matches-verification")
  })

  it("all gates pass evaluation", () => {
    const g1 = createGateResult("required-assignments-complete", true)
    const g2 = createGateResult("current-sha-matches-verification", true)

    const evaluation = aggregateEvaluation([g1, g2])
    expect(evaluation.allPassed).toBe(true)
    expect(evaluation.failingGates).toHaveLength(0)
  })
})
