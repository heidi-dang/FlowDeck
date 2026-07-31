/**
 * Verification Evaluation Service.
 *
 * Evaluates a set of verification results against the current contract
 * specification and SHA. Produces a structured evaluation indicating
 * which rules pass, fail, or are blocked by stale/cross-run conditions.
 *
 * This service is domain-pure: it takes data and returns an evaluation
 * without side effects.
 */

import type { VerificationResult, VerificationResultStatus } from "../domain/verification-result"
import type { CriterionPriority } from "../../contracts/domain/specification"
import { isResultStale } from "../policies/stale-policy"
import { isResultAcceptable } from "../policies/priority-policy"

export interface RuleEvaluationResult {
  readonly ruleId: string
  readonly description: string
  readonly priority: CriterionPriority
  readonly required: boolean
  readonly status: VerificationResultStatus
  readonly acceptable: boolean
  readonly reasons: readonly string[]
}

export interface VerificationEvaluation {
  readonly allRequiredPassed: boolean
  readonly results: readonly RuleEvaluationResult[]
  readonly summary: {
    readonly total: number
    readonly passed: number
    readonly failed: number
    readonly skipped: number
    readonly pending: number
    readonly stale: number
    readonly crossRun: number
  }
}

export interface EvaluateVerificationInput {
  readonly results: readonly VerificationResult[]
  readonly requiredRules: readonly { id: string; description: string; priority: CriterionPriority; required: boolean }[]
  readonly currentSha: string
  readonly expectedRunId: string
}

/**
 * Evaluates all verification results against the current specification
 * and SHA. Returns a structured evaluation.
 */
export function evaluateVerification(input: EvaluateVerificationInput): VerificationEvaluation {
  const ruleResults: RuleEvaluationResult[] = []
  let passed = 0
  let failed = 0
  let skipped = 0
  let pending = 0
  let stale = 0
  let crossRun = 0
  let allRequiredPassed = true

  for (const rule of input.requiredRules) {
    const matchingResults = input.results.filter((r) => r.ruleId === rule.id)
    const result = matchingResults.length > 0 ? matchingResults[0] : undefined

    const reasons: string[] = []

    // Check cross-run
    if (result && result.runId !== input.expectedRunId) {
      reasons.push("Result belongs to a different run")
      crossRun++
    }

    // Check stale
    if (result && isResultStale({ result, currentSha: input.currentSha })) {
      reasons.push(`Result targets SHA ${result.targetSha}, current is ${input.currentSha}`)
      stale++
    }

    // Determine effective status
    let effectiveStatus: VerificationResultStatus
    if (!result) {
      effectiveStatus = "pending"
      reasons.push("No verification result exists for this rule")
    } else if (result.runId !== input.expectedRunId) {
      effectiveStatus = result.status
      if (result.status === "passed") reasons.push("Result passed but belongs to wrong run")
    } else if (isResultStale({ result, currentSha: input.currentSha })) {
      effectiveStatus = result.status
      if (result.status === "passed") reasons.push("Result passed but targets stale SHA")
    } else {
      effectiveStatus = result.status
    }

    // Evaluate acceptability
    // A result is NOT acceptable if it is stale, cross-run, or fails priority policy
    const isCrossRun = result !== undefined && result.runId !== input.expectedRunId
    const isStale = result !== undefined && isResultStale({ result, currentSha: input.currentSha })
    const priorityAcceptable = isResultAcceptable(effectiveStatus, rule.priority)

    const acceptable = priorityAcceptable && !isCrossRun && !isStale && result !== undefined

    // A rule is effectively passing only if it's current, same-run, and passing
    const isEffectivelyPassing = result !== undefined
      && result.status === "passed"
      && !isCrossRun
      && !isStale

    // Track overall pass/fail
    if (!acceptable && rule.required) {
      allRequiredPassed = false
    }

    // Accumulate summary counts
    if (isEffectivelyPassing) {
      passed++
    } else if (!result) {
      pending++
    } else if (result.runId !== input.expectedRunId) {
      // counted in crossRun already, don't add to passed
    } else if (effectiveStatus === "failed") {
      failed++
    } else if (effectiveStatus === "skipped") {
      skipped++
    } else if (effectiveStatus === "pending" || effectiveStatus === "running") {
      pending++
    }

    ruleResults.push({
      ruleId: rule.id,
      description: rule.description,
      priority: rule.priority,
      required: rule.required,
      status: effectiveStatus,
      acceptable,
      reasons: Object.freeze(reasons),
    })
  }

  return {
    allRequiredPassed,
    results: Object.freeze(ruleResults),
    summary: {
      total: input.requiredRules.length,
      passed,
      failed,
      skipped,
      pending,
      stale,
      crossRun,
    },
  }
}
