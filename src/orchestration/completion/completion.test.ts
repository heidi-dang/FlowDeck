/**
 * Completion Gate Tests
 *
 * Tests for each gate's negative case (missing evidence, wrong SHA, etc.).
 * Uses bun:test (vitest-compatible) framework.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { CompletionGate, type CompletionGateInput } from "./completion-gates"
import { evaluateAllGates, evaluateGate } from "./completion-evaluator"
import { CompletionEngine, CompletionCheckResult } from "./completion-engine"

function createBaseInput(): CompletionGateInput {
  return {
    runId: "run-123",
    currentSha: "abc123",
    assignmentsComplete: true,
    verificationResults: [],
    acceptanceCriteria: [],
    requirements: [],
    evidenceItems: [],
  }
}

describe("Gate 1: ASSIGNMENTS_COMPLETE", () => {
  it("FAILS when assignments are not complete", () => {
    const input = createBaseInput()
    input.assignmentsComplete = false

    const result = evaluateGate(CompletionGate.ASSIGNMENTS_COMPLETE, input)

    expect(result.passed).toBe(false)
    expect(result.reasons).toContain("Not all task assignments are complete")
  })

  it("PASSES when all assignments are complete", () => {
    const input = createBaseInput()
    input.assignmentsComplete = true

    const result = evaluateGate(CompletionGate.ASSIGNMENTS_COMPLETE, input)

    expect(result.passed).toBe(true)
  })
})

describe("Gate 2: EXACT_SHA_VERIFIED", () => {
  it("FAILS when no verification results exist for current SHA", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Test rule",
        required: false,
        status: "passed",
        targetSha: "different-sha",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.EXACT_SHA_VERIFIED, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes("No verification results target current SHA"))).toBe(true)
  })

  it("FAILS when some verification results target different SHA", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Test rule",
        required: false,
        status: "passed",
        targetSha: "abc123",
        evidenceIds: [],
      },
      {
        id: "vr-2",
        runId: "run-123",
        ruleId: "rule-2",
        ruleDescription: "Stale rule",
        required: false,
        status: "passed",
        targetSha: "stale-sha",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.EXACT_SHA_VERIFIED, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes("1 verification result(s) target a different SHA"))).toBe(true)
  })

  it("PASSES when all verification results target current SHA", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Test rule",
        required: false,
        status: "passed",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.EXACT_SHA_VERIFIED, input)

    expect(result.passed).toBe(true)
  })
})

describe("Gate 3: CRITICAL_CRITERIA_PASSED", () => {
  it("FAILS when critical criterion has no verification results", () => {
    const input = createBaseInput()
    input.acceptanceCriteria = [
      { id: "c1", description: "Critical criterion 1", priority: "critical" },
    ]

    const result = evaluateGate(CompletionGate.CRITICAL_CRITERIA_PASSED, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes('Critical criterion "Critical criterion 1" has no verification results'))).toBe(true)
  })

  it("FAILS when critical criterion has failed verification", () => {
    const input = createBaseInput()
    input.acceptanceCriteria = [
      { id: "c1", description: "Critical criterion 1", priority: "critical" },
    ]
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "c1",
        ruleDescription: "Critical criterion 1",
        required: false,
        status: "failed",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.CRITICAL_CRITERIA_PASSED, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes("has status: failed"))).toBe(true)
  })

  it("PASSES when critical criterion has passing verification", () => {
    const input = createBaseInput()
    input.acceptanceCriteria = [
      { id: "c1", description: "Critical criterion 1", priority: "critical" },
    ]
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "c1",
        ruleDescription: "Critical criterion 1",
        required: false,
        status: "passed",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.CRITICAL_CRITERIA_PASSED, input)

    expect(result.passed).toBe(true)
  })

  it("PASSES when no critical criteria defined", () => {
    const input = createBaseInput()
    input.acceptanceCriteria = [
      { id: "c1", description: "Low priority criterion", priority: "low" },
    ]

    const result = evaluateGate(CompletionGate.CRITICAL_CRITERIA_PASSED, input)

    expect(result.passed).toBe(true)
  })
})

describe("Gate 4: CRITICAL_REQUIREMENTS_VERIFIED", () => {
  it("FAILS when critical requirement has no verification results", () => {
    const input = createBaseInput()
    input.requirements = [
      { id: "r1", description: "Critical requirement 1", priority: "critical" },
    ]

    const result = evaluateGate(CompletionGate.CRITICAL_REQUIREMENTS_VERIFIED, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes('Critical requirement "Critical requirement 1" has no verification results'))).toBe(true)
  })

  it("FAILS when critical requirement has failed verification", () => {
    const input = createBaseInput()
    input.requirements = [
      { id: "r1", description: "Critical requirement 1", priority: "critical" },
    ]
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "r1",
        ruleDescription: "Critical requirement 1",
        required: false,
        status: "failed",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.CRITICAL_REQUIREMENTS_VERIFIED, input)

    expect(result.passed).toBe(false)
  })

  it("PASSES when critical requirement has passing verification", () => {
    const input = createBaseInput()
    input.requirements = [
      { id: "r1", description: "Critical requirement 1", priority: "critical" },
    ]
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "r1",
        ruleDescription: "Critical requirement 1",
        required: false,
        status: "passed",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.CRITICAL_REQUIREMENTS_VERIFIED, input)

    expect(result.passed).toBe(true)
  })
})

describe("Gate 5: REQUIRED_VERIFICATION_PASSED", () => {
  it("FAILS when required rule belongs to wrong run", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "wrong-run",
        ruleId: "rule-1",
        ruleDescription: "Required rule",
        required: true,
        status: "passed",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.REQUIRED_VERIFICATION_PASSED, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes("belongs to wrong run"))).toBe(true)
  })

  it("FAILS when required rule targets stale SHA", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Required rule",
        required: true,
        status: "passed",
        targetSha: "stale-sha",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.REQUIRED_VERIFICATION_PASSED, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes("targets stale SHA"))).toBe(true)
  })

  it("FAILS when required rule is pending", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Required rule",
        required: true,
        status: "pending",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.REQUIRED_VERIFICATION_PASSED, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes("is pending"))).toBe(true)
  })

  it("FAILS when required rule is still running", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Required rule",
        required: true,
        status: "running",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.REQUIRED_VERIFICATION_PASSED, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes("is still running"))).toBe(true)
  })

  it("FAILS when required rule was skipped", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Required rule",
        required: true,
        status: "skipped",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.REQUIRED_VERIFICATION_PASSED, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes("was skipped but passing is required"))).toBe(true)
  })

  it("FAILS when required rule failed", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Required rule",
        required: true,
        status: "failed",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.REQUIRED_VERIFICATION_PASSED, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes("failed"))).toBe(true)
  })

  it("PASSES when required rule passes", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Required rule",
        required: true,
        status: "passed",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.REQUIRED_VERIFICATION_PASSED, input)

    expect(result.passed).toBe(true)
  })
})

describe("Gate 6: MANDATORY_EVIDENCE_PRESENT", () => {
  it("FAILS when verification results reference evidence but no evidence exists", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Rule with evidence",
        required: false,
        status: "passed",
        targetSha: "abc123",
        evidenceIds: ["ev-1"],
      },
    ]

    const result = evaluateGate(CompletionGate.MANDATORY_EVIDENCE_PRESENT, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes("No evidence items exist but verification results reference evidence"))).toBe(true)
  })

  it("FAILS when evidence targets wrong SHA", () => {
    const input = createBaseInput()
    input.evidenceItems = [
      {
        id: "ev-1",
        sha: "wrong-sha",
        runId: "run-123",
        status: "current",
        criterionIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.MANDATORY_EVIDENCE_PRESENT, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes('Evidence "ev-1" targets SHA wrong-sha, expected abc123'))).toBe(true)
  })

  it("FAILS when evidence belongs to wrong run", () => {
    const input = createBaseInput()
    input.evidenceItems = [
      {
        id: "ev-1",
        sha: "abc123",
        runId: "wrong-run",
        status: "current",
        criterionIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.MANDATORY_EVIDENCE_PRESENT, input)

    expect(result.passed).toBe(false)
    expect(result.reasons?.some((r) => r.includes('Evidence "ev-1" belongs to run wrong-run, expected run-123'))).toBe(true)
  })

  it("FAILS when required result references evidence but none is current and SHA-matched", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Required rule",
        required: true,
        status: "passed",
        targetSha: "abc123",
        evidenceIds: ["ev-1"],
      },
    ]
    input.evidenceItems = [
      {
        id: "ev-1",
        sha: "stale-sha",
        runId: "run-123",
        status: "current",
        criterionIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.MANDATORY_EVIDENCE_PRESENT, input)

    expect(result.passed).toBe(false)
  })

  it("PASSES when evidence is current and SHA-matched", () => {
    const input = createBaseInput()
    input.evidenceItems = [
      {
        id: "ev-1",
        sha: "abc123",
        runId: "run-123",
        status: "current",
        criterionIds: [],
      },
    ]

    const result = evaluateGate(CompletionGate.MANDATORY_EVIDENCE_PRESENT, input)

    expect(result.passed).toBe(true)
  })

  it("PASSES when no evidence and no evidence references", () => {
    const input = createBaseInput()
    input.evidenceItems = []
    input.verificationResults = []

    const result = evaluateGate(CompletionGate.MANDATORY_EVIDENCE_PRESENT, input)

    expect(result.passed).toBe(true)
  })
})

describe("evaluateAllGates", () => {
  it("returns all gates evaluated", () => {
    const input = createBaseInput()

    const result = evaluateAllGates(input)

    expect(result.totalCount).toBe(6)
    expect(result.gateResults.length).toBe(6)
  })

  it("reports allPassed false when any gate fails", () => {
    const input = createBaseInput()
    input.assignmentsComplete = false

    const result = evaluateAllGates(input)

    expect(result.allPassed).toBe(false)
    expect(result.passedCount).toBeLessThan(result.totalCount)
    expect(result.failingGates.length).toBeGreaterThan(0)
  })

  it("reports allPassed true only when all gates pass", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Required rule",
        required: true,
        status: "passed",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result = evaluateAllGates(input)

    expect(result.allPassed).toBe(true)
    expect(result.passedCount).toBe(result.totalCount)
  })
})

describe("CompletionEngine", () => {
  let engine: CompletionEngine

  beforeEach(() => {
    engine = new CompletionEngine()
  })

  it("is idempotent - same input returns same result", () => {
    const input = createBaseInput()

    const result1 = engine.checkCompletion(input)
    const result2 = engine.checkCompletion(input)

    expect(result1.canComplete).toBe(result2.canComplete)
    expect(result1.evaluation.passedCount).toBe(result2.evaluation.passedCount)
  })

  it("forceCheckCompletion bypasses idempotency cache", () => {
    const input = createBaseInput()
    input.assignmentsComplete = true
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Required rule",
        required: true,
        status: "passed",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    const result1 = engine.checkCompletion(input)
    expect(result1.canComplete).toBe(true)

    input.assignmentsComplete = false
    const result2 = engine.forceCheckCompletion(input)
    expect(result2.canComplete).toBe(false)

    const cachedResult = engine.checkCompletion({ ...createBaseInput(), assignmentsComplete: false })
    expect(cachedResult.canComplete).toBe(false)
  })

  it("clearCache removes all cached results", () => {
    const input = createBaseInput()
    input.verificationResults = [
      {
        id: "vr-1",
        runId: "run-123",
        ruleId: "rule-1",
        ruleDescription: "Required rule",
        required: true,
        status: "passed",
        targetSha: "abc123",
        evidenceIds: [],
      },
    ]

    engine.checkCompletion(input)
    expect(engine.checkCompletion(input).canComplete).toBe(true)

    engine.clearCache()

    input.assignmentsComplete = false
    const result = engine.forceCheckCompletion(input)
    expect(result.canComplete).toBe(false)
  })

  it("getRequiredGates returns all 6 gates", () => {
    const gates = engine.getRequiredGates()

    expect(gates.length).toBe(6)
    expect(gates).toContain(CompletionGate.ASSIGNMENTS_COMPLETE)
    expect(gates).toContain(CompletionGate.EXACT_SHA_VERIFIED)
    expect(gates).toContain(CompletionGate.CRITICAL_CRITERIA_PASSED)
    expect(gates).toContain(CompletionGate.CRITICAL_REQUIREMENTS_VERIFIED)
    expect(gates).toContain(CompletionGate.REQUIRED_VERIFICATION_PASSED)
    expect(gates).toContain(CompletionGate.MANDATORY_EVIDENCE_PRESENT)
  })

  it("summarizeResult produces readable output", () => {
    const input = createBaseInput()
    input.assignmentsComplete = false

    const result = engine.checkCompletion(input)
    const summary = CompletionEngine.summarizeResult(result)

    expect(summary).toContain("BLOCKED")
    expect(summary).toContain("Gates passed")
  })
})
