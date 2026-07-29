/**
 * Completion Evaluation Service.
 *
 * Evaluates all six completion gates in one authoritative policy.
 * Each gate returns a structured result with reasons for failure.
 *
 * The six gates:
 * 1. Required assignments complete
 * 2. Current SHA equals verification SHA
 * 3. Required critical acceptance criteria passed
 * 4. Required critical requirements verified
 * 5. Required verification policy satisfied
 * 6. Mandatory evidence is current and SHA-matched
 *
 * Override integration belongs to Phase 2C.
 */

import {
  type GateResult,
  type CompletionEvaluation,
  createGateResult,
  aggregateEvaluation,
} from "../domain/evaluation"

import type { VerificationResult } from "../../verification/domain/verification-result"
import type { Evidence } from "../../evidence/domain/evidence"
import { isResultStale } from "../../verification/policies/stale-policy"

export interface CompletionEvaluationInput {
  readonly requiredAssignmentsComplete: boolean
  readonly currentSha: string
  readonly verificationResults: readonly VerificationResult[]
  readonly expectedRunId: string
  readonly requirements: readonly { id: string; description: string; priority: string }[]
  readonly acceptanceCriteria: readonly { id: string; description: string; priority: string }[]
  readonly evidenceItems: readonly Evidence[]
}

/**
 * Evaluates all six completion gates.
 * Returns a structured evaluation with pass/fail per gate and reasons.
 */
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

// ── Gate 1: Required assignments complete ──────────────────────────────

function evaluateGate1(input: CompletionEvaluationInput): GateResult {
  const reasons: string[] = []

  if (input.requiredAssignmentsComplete) {
    return createGateResult("required-assignments-complete", true)
  }

  reasons.push("Not all required assignments are complete")
  return createGateResult("required-assignments-complete", false, reasons)
}

// ── Gate 2: Current SHA matches verification SHA ──────────────────────

function evaluateGate2(input: CompletionEvaluationInput): GateResult {
  const reasons: string[] = []

  const currentShaResults = input.verificationResults.filter(
    (r) => !isResultStale({ result: r, currentSha: input.currentSha }),
  )

  if (currentShaResults.length === 0) {
    reasons.push(`No verification results target the current SHA: ${input.currentSha}`)
    return createGateResult("current-sha-matches-verification", false, reasons)
  }

  const allMatchCurrentSha = currentShaResults.length === input.verificationResults.length
  if (!allMatchCurrentSha) {
    const staleCount = input.verificationResults.length - currentShaResults.length
    reasons.push(`${staleCount} verification result(s) target a different SHA`)
    return createGateResult("current-sha-matches-verification", false, reasons)
  }

  return createGateResult("current-sha-matches-verification", true)
}

// ── Gate 3: Required critical acceptance criteria passed ───────────────

function evaluateGate3(input: CompletionEvaluationInput): GateResult {
  const reasons: string[] = []

  const criticalCriteria = input.acceptanceCriteria.filter((c) => c.priority === "critical")

  if (criticalCriteria.length === 0) {
    return createGateResult("critical-acceptance-criteria-passed", true)
  }

  for (const criterion of criticalCriteria) {
    // Check that relevant verification results pass for this criterion
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
      if (currentResults.length === 0) {
        reasons.push(`Critical criterion "${criterion.description}" has no current verification results`)
      } else {
        const statuses = currentResults.map((r) => r.status).join(", ")
        reasons.push(`Critical criterion "${criterion.description}" has status: ${statuses}`)
      }
    }
  }

  if (reasons.length === 0) {
    return createGateResult("critical-acceptance-criteria-passed", true)
  }

  return createGateResult("critical-acceptance-criteria-passed", false, reasons)
}

// ── Gate 4: Required critical requirements verified ────────────────────

function evaluateGate4(input: CompletionEvaluationInput): GateResult {
  const reasons: string[] = []

  const criticalReqs = input.requirements.filter((r) => r.priority === "critical")

  if (criticalReqs.length === 0) {
    return createGateResult("critical-requirements-verified", true)
  }

  for (const req of criticalReqs) {
    const matchingResults = input.verificationResults.filter(
      (r) => r.ruleId === req.id
    )

    const currentResults = matchingResults.filter(
      (r) => !isResultStale({ result: r, currentSha: input.currentSha }) && r.runId === input.expectedRunId
    )

    const passingResults = currentResults.filter((r) => r.isPassing)

    if (passingResults.length === 0) {
      if (currentResults.length === 0) {
        reasons.push(`Critical requirement "${req.description}" has no current verification results`)
      } else {
        const statuses = currentResults.map((r) => r.status).join(", ")
        reasons.push(`Critical requirement "${req.description}" has status: ${statuses}`)
      }
    }
  }

  if (reasons.length === 0) {
    return createGateResult("critical-requirements-verified", true)
  }

  return createGateResult("critical-requirements-verified", false, reasons)
}

// ── Gate 5: Required verification policy satisfied ────────────────────

function evaluateGate5(input: CompletionEvaluationInput): GateResult {
  const reasons: string[] = []

  // Collect all required verification rules (rules that are marked required)
  const requiredRules = input.verificationResults.filter((r) => r.required)

  if (requiredRules.length === 0) {
    return createGateResult("verification-policy-satisfied", true)
  }

  for (const rule of requiredRules) {
    // Check cross-run
    if (rule.runId !== input.expectedRunId) {
      reasons.push(`Required rule "${rule.ruleDescription}" result belongs to wrong run`)
      continue
    }

    // Check stale
    if (isResultStale({ result: rule, currentSha: input.currentSha })) {
      reasons.push(`Required rule "${rule.ruleDescription}" targets stale SHA ${rule.targetSha}`)
      continue
    }

    // Check status
    if (rule.status === "pending") {
      reasons.push(`Required rule "${rule.ruleDescription}" is pending`)
    } else if (rule.status === "running") {
      reasons.push(`Required rule "${rule.ruleDescription}" is still running`)
    } else if (rule.status === "skipped") {
      reasons.push(`Required rule "${rule.ruleDescription}" was skipped but passing is required`)
    } else if (rule.status === "failed") {
      reasons.push(`Required rule "${rule.ruleDescription}" failed`)
    }
  }

  if (reasons.length === 0) {
    return createGateResult("verification-policy-satisfied", true)
  }

  return createGateResult("verification-policy-satisfied", false, reasons)
}

// ── Gate 6: Mandatory evidence is current and SHA-matched ──────────────

function evaluateGate6(input: CompletionEvaluationInput): GateResult {
  const reasons: string[] = []

  // Check all evidence items for SHA match and run ownership
  if (input.evidenceItems.length === 0) {
    // If there are no verification results either, this might be trivially true
    // But if we have results, we should have evidence
    if (input.verificationResults.some((r) => r.evidenceIds.length > 0)) {
      reasons.push("No evidence items exist but some verification results reference evidence")
      return createGateResult("mandatory-evidence-current", false, reasons)
    }
    return createGateResult("mandatory-evidence-current", true)
  }

  for (const evidence of input.evidenceItems) {
    if (evidence.isArchived) {
      // Archived evidence is still traceable but not current
      // We track this but don't fail the gate unless it's the only evidence
      continue
    }

    if (!evidence.matchesSha(input.currentSha)) {
      reasons.push(
        `Evidence "${evidence.id}" targets SHA ${evidence.sha}, expected ${input.currentSha}`
      )
      continue
    }

    if (!evidence.belongsToRun(input.expectedRunId)) {
      reasons.push(
        `Evidence "${evidence.id}" belongs to run ${evidence.runId}, expected ${input.expectedRunId}`
      )
      continue
    }
  }

  // Check that all verification results that require evidence have it
  for (const result of input.verificationResults) {
    if (result.required && result.status !== "skipped") {
      const hasCurrentEvidence = result.evidenceIds.some((eid) => {
        const ev = input.evidenceItems.find((e) => e.id === eid)
        return ev && !ev.isArchived && ev.matchesSha(input.currentSha) && ev.belongsToRun(input.expectedRunId)
      })

      if (!hasCurrentEvidence && result.evidenceIds.length > 0) {
        reasons.push(
          `Required result "${result.ruleDescription}" references evidence but none is current and SHA-matched`
        )
      }
    }
  }

  if (reasons.length === 0) {
    return createGateResult("mandatory-evidence-current", true)
  }

  return createGateResult("mandatory-evidence-current", false, reasons)
}
