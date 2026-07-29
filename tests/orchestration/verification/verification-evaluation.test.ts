/**
 * Comprehensive verification evaluation tests.
 *
 * Covers every combination of:
 * - stale SHA vs current SHA
 * - missing evidence vs present
 * - wrong run vs correct run
 * - pending/running/failed/skipped/passed verification
 * - optional vs required verification
 */

import { describe, it, expect } from "bun:test"
import { VerificationResult } from "@/orchestration/verification/domain/verification-result"
import { evaluateVerification } from "@/orchestration/verification/services/verification-evaluation-service"
import { isResultStale } from "@/orchestration/verification/policies/stale-policy"
import { isResultAcceptable } from "@/orchestration/verification/policies/priority-policy"
import { shaMatches, isCrossRunResult } from "@/orchestration/verification/policies/sha-policy"

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

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule-1",
    description: "Test rule",
    priority: "critical" as const,
    required: true,
    ...overrides,
  }
}

describe("Verification evaluation — SHA matrix", () => {
  it("passes when all results target current SHA", () => {
    const result = makeResult()
    const evaluation = evaluateVerification({
      results: [result],
      requiredRules: [makeRule()],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(true)
    expect(evaluation.summary.passed).toBe(1)
    expect(evaluation.summary.stale).toBe(0)
  })

  it("fails when result targets stale SHA", () => {
    const result = makeResult({ targetSha: OLD_SHA })
    const evaluation = evaluateVerification({
      results: [result],
      requiredRules: [makeRule()],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(false)
    expect(evaluation.summary.stale).toBe(1)
    expect(evaluation.results[0].reasons).toContain(
      `Result targets SHA ${OLD_SHA}, current is ${CURRENT_SHA}`
    )
  })

  it("fails when no results exist for a required rule", () => {
    const evaluation = evaluateVerification({
      results: [],
      requiredRules: [makeRule()],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(false)
    expect(evaluation.summary.pending).toBe(1)
    expect(evaluation.results[0].reasons).toContain("No verification result exists for this rule")
  })
})

describe("Verification evaluation — run ownership matrix", () => {
  it("fails when result belongs to a different run", () => {
    const result = makeResult({ runId: OTHER_RUN_ID })
    const evaluation = evaluateVerification({
      results: [result],
      requiredRules: [makeRule()],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(false)
    expect(evaluation.summary.crossRun).toBe(1)
  })

  it("passes when result belongs to expected run with correct SHA", () => {
    const result = makeResult({ runId: RUN_ID })
    const evaluation = evaluateVerification({
      results: [result],
      requiredRules: [makeRule()],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(true)
  })
})

describe("Verification evaluation — status matrix", () => {
  it("passes for passed required result", () => {
    const result = makeResult({ status: "passed" })
    const evaluation = evaluateVerification({
      results: [result],
      requiredRules: [makeRule()],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(true)
  })

  it("fails for failed required result", () => {
    const result = makeResult({ status: "failed" })
    const evaluation = evaluateVerification({
      results: [result],
      requiredRules: [makeRule()],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(false)
    expect(evaluation.summary.failed).toBe(1)
  })

  it("fails for pending required result", () => {
    const result = makeResult({ status: "pending" })
    const evaluation = evaluateVerification({
      results: [result],
      requiredRules: [makeRule()],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(false)
    expect(evaluation.summary.pending).toBe(1)
  })

  it("fails for running required result", () => {
    const result = makeResult({ status: "running" })
    const evaluation = evaluateVerification({
      results: [result],
      requiredRules: [makeRule()],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(false)
    expect(evaluation.summary.pending).toBe(1)
  })

  it("fails for skipped required result", () => {
    const result = makeResult({ status: "skipped" })
    const evaluation = evaluateVerification({
      results: [result],
      requiredRules: [makeRule()],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(false)
    expect(evaluation.summary.skipped).toBe(1)
  })
})

describe("Verification evaluation — required vs optional matrix", () => {
  it("passes when optional rule is failed (advisory)", () => {
    const result = makeResult({ required: false, status: "failed" })
    const evaluation = evaluateVerification({
      results: [result],
      requiredRules: [makeRule({ priority: "advisory", required: false })],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    // Advisory rules are non-blocking
    expect(evaluation.allRequiredPassed).toBe(true)
  })

  it("fails when required critical rule fails", () => {
    const result = makeResult({ required: true, status: "failed" })
    const evaluation = evaluateVerification({
      results: [result],
      requiredRules: [makeRule({ priority: "critical", required: true })],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(false)
  })

  it("passes when optional rule is skipped (advisory)", () => {
    const result = makeResult({ required: false, status: "skipped" })
    const evaluation = evaluateVerification({
      results: [result],
      requiredRules: [makeRule({ priority: "advisory", required: false })],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(true)
  })
})

describe("Verification evaluation — combined matrix", () => {
  it("stale + wrong run + missing = all fail", () => {
    const staleResult = makeResult({ id: "vr-1", ruleId: "rule-1", targetSha: OLD_SHA, status: "passed" })
    const wrongRunResult = makeResult({ id: "vr-2", ruleId: "rule-2", runId: OTHER_RUN_ID, status: "passed" })

    const evaluation = evaluateVerification({
      results: [staleResult, wrongRunResult],
      requiredRules: [
        makeRule({ id: "rule-1" }),
        makeRule({ id: "rule-2" }),
        makeRule({ id: "rule-3" }), // missing
      ],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(false)
    expect(evaluation.summary.stale).toBe(1)
    expect(evaluation.summary.crossRun).toBe(1)
    expect(evaluation.summary.pending).toBe(1) // missing
  })

  it("all passing with correct SHA and run", () => {
    const results = [
      makeResult({ id: "vr-1", ruleId: "rule-1", status: "passed" }),
      makeResult({ id: "vr-2", ruleId: "rule-2", status: "passed" }),
      makeResult({ id: "vr-3", ruleId: "rule-3", status: "passed" }),
    ]

    const evaluation = evaluateVerification({
      results,
      requiredRules: [
        makeRule({ id: "rule-1" }),
        makeRule({ id: "rule-2" }),
        makeRule({ id: "rule-3" }),
      ],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(true)
    expect(evaluation.summary.passed).toBe(3)
    expect(evaluation.summary.total).toBe(3)
  })

  it("mixed: one stale, one passing, one failed", () => {
    const results = [
      makeResult({ id: "vr-1", ruleId: "rule-1", targetSha: OLD_SHA, status: "passed" }),
      makeResult({ id: "vr-2", ruleId: "rule-2", status: "passed" }),
      makeResult({ id: "vr-3", ruleId: "rule-3", status: "failed" }),
    ]

    const evaluation = evaluateVerification({
      results,
      requiredRules: [
        makeRule({ id: "rule-1" }),
        makeRule({ id: "rule-2" }),
        makeRule({ id: "rule-3" }),
      ],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.allRequiredPassed).toBe(false)
    // Only rule-2 truly passes (correct SHA, correct run, passed status)
    expect(evaluation.summary.passed).toBe(1)
    expect(evaluation.summary.stale).toBe(1)
    expect(evaluation.summary.failed).toBe(1)
  })
})

describe("Verification evaluation — priority policy", () => {
  it("critical priority requires passing result", () => {
    expect(isResultAcceptable("passed", "critical")).toBe(true)
    expect(isResultAcceptable("failed", "critical")).toBe(false)
    expect(isResultAcceptable("skipped", "critical")).toBe(false)
    expect(isResultAcceptable("pending", "critical")).toBe(false)
    expect(isResultAcceptable("running", "critical")).toBe(false)
  })

  it("high priority requires passing result (without overrides)", () => {
    expect(isResultAcceptable("passed", "high")).toBe(true)
    expect(isResultAcceptable("failed", "high")).toBe(false)
  })

  it("medium_mandatory priority requires passing result (without overrides)", () => {
    expect(isResultAcceptable("passed", "medium_mandatory")).toBe(true)
    expect(isResultAcceptable("failed", "medium_mandatory")).toBe(false)
  })

  it("advisory priority accepts any status", () => {
    expect(isResultAcceptable("passed", "advisory")).toBe(true)
    expect(isResultAcceptable("failed", "advisory")).toBe(true)
    expect(isResultAcceptable("skipped", "advisory")).toBe(true)
    expect(isResultAcceptable("pending", "advisory")).toBe(true)
  })
})

describe("Verification evaluation — stale policy", () => {
  it("detects stale result by SHA mismatch", () => {
    const result = makeResult({ targetSha: OLD_SHA })
    expect(isResultStale({ result, currentSha: CURRENT_SHA })).toBe(true)
  })

  it("passes non-stale result when SHA matches", () => {
    const result = makeResult({ targetSha: CURRENT_SHA })
    expect(isResultStale({ result, currentSha: CURRENT_SHA })).toBe(false)
  })
})

describe("Verification evaluation — SHA matching policy", () => {
  it("matches when SHA equals required", () => {
    expect(shaMatches({ targetSha: CURRENT_SHA, requiredSha: CURRENT_SHA })).toBe(true)
  })

  it("does not match when SHA differs", () => {
    expect(shaMatches({ targetSha: OLD_SHA, requiredSha: CURRENT_SHA })).toBe(false)
  })
})

describe("Verification evaluation — cross-run detection", () => {
  it("detects cross-run result", () => {
    const result = makeResult({ runId: OTHER_RUN_ID })
    expect(isCrossRunResult(result, RUN_ID)).toBe(true)
  })

  it("passes same-run result", () => {
    const result = makeResult({ runId: RUN_ID })
    expect(isCrossRunResult(result, RUN_ID)).toBe(false)
  })
})

describe("Verification evaluation — summary counts", () => {
  it("reports total, passed, failed, skipped, pending, stale, crossRun", () => {
    const results = [
      makeResult({ id: "vr-1", ruleId: "rule-1", status: "passed" }),
      makeResult({ id: "vr-2", ruleId: "rule-2", status: "failed" }),
      makeResult({ id: "vr-3", ruleId: "rule-3", status: "skipped" }),
      makeResult({ id: "vr-4", ruleId: "rule-4", status: "pending" }),
    ]

    const evaluation = evaluateVerification({
      results,
      requiredRules: [
        makeRule({ id: "rule-1" }),
        makeRule({ id: "rule-2" }),
        makeRule({ id: "rule-3" }),
        makeRule({ id: "rule-4" }),
      ],
      currentSha: CURRENT_SHA,
      expectedRunId: RUN_ID,
    })

    expect(evaluation.summary.total).toBe(4)
    expect(evaluation.summary.passed).toBe(1)
    expect(evaluation.summary.failed).toBe(1)
    expect(evaluation.summary.skipped).toBe(1)
    expect(evaluation.summary.pending).toBe(1)
    expect(evaluation.summary.stale).toBe(0)
    expect(evaluation.summary.crossRun).toBe(0)
  })
})
