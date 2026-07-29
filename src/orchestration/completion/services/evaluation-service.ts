/**
 * Completion Evaluation Service — six-gate evaluation with typed failure codes.
 */

import { type GateResult, type CompletionEvaluation, type GateFailure, createGateResult, aggregateEvaluation } from "../domain/evaluation"
import { type VerificationResult } from "../../verification/domain/verification-result"
import { type Evidence } from "../../evidence/domain/evidence"
import { isResultStale } from "../../verification/policies/stale-policy"
import type { CompletionFailureCode } from "../../common/types"

export interface CompletionEvaluationInput {
  readonly requiredAssignmentsComplete: boolean
  readonly currentSha: string
  readonly verificationResults: readonly VerificationResult[]
  readonly expectedRunId: string
  readonly requirements: readonly { id: string; description: string; priority: string }[]
  readonly acceptanceCriteria: readonly { id: string; description: string; priority: string }[]
  readonly evidenceItems: readonly Evidence[]
}

export function evaluateCompletion(input: CompletionEvaluationInput): CompletionEvaluation {
  const gates: GateResult[] = [
    evaluateGate1(input),
    evaluateGate2(input),
    evaluateGate3(input),
    evaluateGate4(input),
    evaluateGate5(input),
    evaluateGate6(input),
  ]
  return aggregateEvaluation(gates)
}

function fail(gateId: any, code: CompletionFailureCode, message: string, facts: [string, string][] = []): GateResult {
  const failure: GateFailure = { code, message, facts: Object.freeze(facts.map((x) => Object.freeze(x))) }
  return createGateResult(gateId, false, [failure], [message])
}

function pass(gateId: any): GateResult {
  return createGateResult(gateId, true)
}

function evaluateGate1(input: CompletionEvaluationInput): GateResult {
  if (!input.requiredAssignmentsComplete) {
    return fail("required-assignments-complete", "ASSIGNMENTS_INCOMPLETE", "Not all required assignments are complete")
  }
  return pass("required-assignments-complete")
}

function evaluateGate2(input: CompletionEvaluationInput): GateResult {
  const currentShaResults = input.verificationResults.filter(
    (r) => !isResultStale({ result: r, currentSha: input.currentSha }),
  )

  if (currentShaResults.length === 0) {
    return fail("current-sha-matches-verification", "CURRENT_SHA_MISMATCH",
      `No verification results target the current SHA: ${input.currentSha}`,
      [["expectedSha", input.currentSha]])
  }

  const staleCount = input.verificationResults.length - currentShaResults.length
  if (staleCount > 0) {
    return fail("current-sha-matches-verification", "CURRENT_SHA_MISMATCH",
      `${staleCount} verification result(s) target a different SHA`,
      [["staleCount", String(staleCount)]])
  }

  return pass("current-sha-matches-verification")
}

function evaluateGate3(input: CompletionEvaluationInput): GateResult {
  const failures: GateFailure[] = []
  const reasons: string[] = []

  const criticalCriteria = input.acceptanceCriteria.filter((c) => c.priority === "critical")
  if (criticalCriteria.length === 0) return pass("critical-acceptance-criteria-passed")

  for (const criterion of criticalCriteria) {
    const matchingResults = input.verificationResults.filter(
      (r) => r.ruleId === criterion.id || r.evidenceIds.some((eid) =>
        input.evidenceItems.some((e) => e.id === eid && e.criterionIds.includes(criterion.id))
      )
    )
    const currentResults = matchingResults.filter(
      (r) => !isResultStale({ result: r, currentSha: input.currentSha }) && r.runId === input.expectedRunId
    )
    const passingResults = currentResults.filter((r) => r.isPassing)

    if (passingResults.length === 0) {
      const msg = currentResults.length === 0
        ? `Critical criterion "${criterion.description}" has no current verification results`
        : `Critical criterion "${criterion.description}" has status: ${currentResults.map((r) => r.status).join(", ")}`
      failures.push({ code: "CRITICAL_CRITERIA_FAILED" as CompletionFailureCode, message: msg, facts: Object.freeze([["criterionId", criterion.id]]) })
      reasons.push(msg)
    }
  }

  if (failures.length === 0) return pass("critical-acceptance-criteria-passed")
  return createGateResult("critical-acceptance-criteria-passed", false, failures, reasons)
}

function evaluateGate4(input: CompletionEvaluationInput): GateResult {
  const failures: GateFailure[] = []
  const reasons: string[] = []

  const criticalReqs = input.requirements.filter((r) => r.priority === "critical")
  if (criticalReqs.length === 0) return pass("critical-requirements-verified")

  for (const req of criticalReqs) {
    const matchingResults = input.verificationResults.filter((r) => r.ruleId === req.id)
    const currentResults = matchingResults.filter(
      (r) => !isResultStale({ result: r, currentSha: input.currentSha }) && r.runId === input.expectedRunId
    )
    const passingResults = currentResults.filter((r) => r.isPassing)

    if (passingResults.length === 0) {
      const msg = currentResults.length === 0
        ? `Critical requirement "${req.description}" has no current verification results`
        : `Critical requirement "${req.description}" has status: ${currentResults.map((r) => r.status).join(", ")}`
      failures.push({ code: "CRITICAL_REQUIREMENTS_FAILED" as CompletionFailureCode, message: msg, facts: Object.freeze([["requirementId", req.id]]) })
      reasons.push(msg)
    }
  }

  if (failures.length === 0) return pass("critical-requirements-verified")
  return createGateResult("critical-requirements-verified", false, failures, reasons)
}

function evaluateGate5(input: CompletionEvaluationInput): GateResult {
  const failures: GateFailure[] = []
  const reasons: string[] = []

  const requiredRules = input.verificationResults.filter((r) => r.required)
  if (requiredRules.length === 0) return pass("verification-policy-satisfied")

  for (const rule of requiredRules) {
    let code: CompletionFailureCode = "VERIFICATION_POLICY_FAILED"
    let msg = ""

    if (rule.runId !== input.expectedRunId) {
      code = "VERIFICATION_POLICY_FAILED"
      msg = `Required rule "${rule.ruleDescription}" result belongs to wrong run`
    } else if (isResultStale({ result: rule, currentSha: input.currentSha })) {
      code = "CURRENT_SHA_MISMATCH"
      msg = `Required rule "${rule.ruleDescription}" targets stale SHA ${rule.targetSha}`
    } else if (rule.status === "pending") {
      msg = `Required rule "${rule.ruleDescription}" is pending`
    } else if (rule.status === "running") {
      msg = `Required rule "${rule.ruleDescription}" is still running`
    } else if (rule.status === "skipped") {
      msg = `Required rule "${rule.ruleDescription}" was skipped but passing is required`
    } else if (rule.status === "failed") {
      msg = `Required rule "${rule.ruleDescription}" failed`
    }

    if (msg) {
      failures.push({ code, message: msg, facts: Object.freeze([["ruleId", rule.ruleId], ["status", rule.status]]) })
      reasons.push(msg)
    }
  }

  if (failures.length === 0) return pass("verification-policy-satisfied")
  return createGateResult("verification-policy-satisfied", false, failures, reasons)
}

function evaluateGate6(input: CompletionEvaluationInput): GateResult {
  const failures: GateFailure[] = []
  const reasons: string[] = []

  if (input.evidenceItems.length === 0) {
    if (input.verificationResults.some((r) => r.evidenceIds.length > 0)) {
      return fail("mandatory-evidence-current", "MANDATORY_EVIDENCE_MISSING",
        "No evidence items exist but some verification results reference evidence")
    }
    return pass("mandatory-evidence-current")
  }

  for (const evidence of input.evidenceItems) {
    if (!evidence.isArchived) {
      if (!evidence.matchesSha(input.currentSha)) {
        failures.push({ code: "CURRENT_SHA_MISMATCH" as CompletionFailureCode,
          message: `Evidence "${evidence.id}" targets SHA ${evidence.sha}, expected ${input.currentSha}`,
          facts: Object.freeze([["evidenceId", evidence.id], ["expectedSha", input.currentSha], ["actualSha", evidence.sha]]) })
        reasons.push(`Evidence "${evidence.id}" targets SHA ${evidence.sha}, expected ${input.currentSha}`)
      }
      if (!evidence.belongsToRun(input.expectedRunId)) {
        failures.push({ code: "MANDATORY_EVIDENCE_MISSING" as CompletionFailureCode,
          message: `Evidence "${evidence.id}" belongs to run ${evidence.runId}, expected ${input.expectedRunId}`,
          facts: Object.freeze([["evidenceId", evidence.id], ["expectedRunId", input.expectedRunId], ["actualRunId", evidence.runId]]) })
        reasons.push(`Evidence "${evidence.id}" belongs to run ${evidence.runId}, expected ${input.expectedRunId}`)
      }
    }
  }

  // Check verification results that require evidence
  for (const result of input.verificationResults) {
    if (result.required && result.status !== "skipped") {
      const hasCurrentEvidence = result.evidenceIds.some((eid) => {
        const ev = input.evidenceItems.find((e) => e.id === eid)
        return ev && !ev.isArchived && ev.matchesSha(input.currentSha) && ev.belongsToRun(input.expectedRunId)
      })
      if (!hasCurrentEvidence && result.evidenceIds.length > 0) {
        failures.push({ code: "MANDATORY_EVIDENCE_MISSING" as CompletionFailureCode,
          message: `Required result "${result.ruleDescription}" references evidence but none is current and SHA-matched`,
          facts: Object.freeze([["ruleId", result.ruleId]]) })
        reasons.push(`Required result "${result.ruleDescription}" references evidence but none is current and SHA-matched`)
      }
    }
  }

  if (failures.length === 0) return pass("mandatory-evidence-current")
  return createGateResult("mandatory-evidence-current", false, failures, reasons)
}
