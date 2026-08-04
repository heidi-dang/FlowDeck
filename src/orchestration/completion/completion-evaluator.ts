/**
 * Completion Evaluator
 *
 * Evaluates each of the 6 completion gates and aggregates results.
 * Deterministic gate evaluation - same input always produces same output.
 */

import { CompletionGate, GateResult, CompletionGateInput } from "./completion-gates"

export interface AggregatedGateResult {
  allPassed: boolean;
  gateResults: readonly GateResult[];
  passedCount: number;
  totalCount: number;
  failingGates: readonly GateResult[];
}

function isResultStale(result: { targetSha: string }, currentSha: string): boolean {
  return result.targetSha !== currentSha
}

function createPass(gate: CompletionGate, reasons: string[] = []): GateResult {
  return { gate, passed: true, reasons: reasons.length > 0 ? reasons : undefined }
}

function createFail(gate: CompletionGate, reasons: string[], evidence?: Record<string, unknown>): GateResult {
  return { gate, passed: false, reasons, evidence }
}

/**
 * Evaluates Gate 1: ASSIGNMENTS_COMPLETE
 * All task assignments must be completed.
 */
function evaluateAssignmentsComplete(input: CompletionGateInput): GateResult {
  if (!input.assignmentsComplete) {
    return createFail(
      CompletionGate.ASSIGNMENTS_COMPLETE,
      ["Not all task assignments are complete"],
      { assignmentsComplete: false }
    )
  }
  return createPass(CompletionGate.ASSIGNMENTS_COMPLETE, ["All assignments completed"])
}

/**
 * Evaluates Gate 2: EXACT_SHA_VERIFIED
 * Verification results must target the exact current SHA.
 */
function evaluateExactShaVerified(input: CompletionGateInput): GateResult {
  const currentShaResults = input.verificationResults.filter(
    (r) => !isResultStale(r, input.currentSha)
  )

  if (currentShaResults.length === 0) {
    return createFail(
      CompletionGate.EXACT_SHA_VERIFIED,
      [`No verification results target current SHA: ${input.currentSha}`],
      { expectedSha: input.currentSha, matchingResults: 0 }
    )
  }

  const staleCount = input.verificationResults.length - currentShaResults.length
  if (staleCount > 0) {
    return createFail(
      CompletionGate.EXACT_SHA_VERIFIED,
      [`${staleCount} verification result(s) target a different SHA`],
      { expectedSha: input.currentSha, staleCount }
    )
  }

  return createPass(CompletionGate.EXACT_SHA_VERIFIED, [`SHA ${input.currentSha} verified`])
}

/**
 * Evaluates Gate 3: CRITICAL_CRITERIA_PASSED
 * All critical acceptance criteria must have passing verification.
 */
function evaluateCriticalCriteriaPassed(input: CompletionGateInput): GateResult {
  const criticalCriteria = input.acceptanceCriteria.filter((c) => c.priority === "critical")

  if (criticalCriteria.length === 0) {
    return createPass(CompletionGate.CRITICAL_CRITERIA_PASSED, ["No critical criteria defined"])
  }

  const failures: string[] = []

  for (const criterion of criticalCriteria) {
    const matchingResults = input.verificationResults.filter(
      (r) =>
        r.ruleId === criterion.id ||
        r.evidenceIds.some((eid) =>
          input.evidenceItems.some((e) => e.id === eid && e.criterionIds.includes(criterion.id))
        )
    )

    const currentResults = matchingResults.filter(
      (r) =>
        !isResultStale(r, input.currentSha) &&
        r.runId === input.runId
    )

    const passingResults = currentResults.filter((r) => r.status === "passed")

    if (passingResults.length === 0) {
      const msg =
        currentResults.length === 0
          ? `Critical criterion "${criterion.description}" has no verification results`
          : `Critical criterion "${criterion.description}" has status: ${currentResults.map((r) => r.status).join(", ")}`
      failures.push(msg)
    }
  }

  if (failures.length > 0) {
    return createFail(
      CompletionGate.CRITICAL_CRITERIA_PASSED,
      failures,
      { criticalCriteriaCount: criticalCriteria.length, failedCount: failures.length }
    )
  }

  return createPass(CompletionGate.CRITICAL_CRITERIA_PASSED, ["All critical criteria passed"])
}

/**
 * Evaluates Gate 4: CRITICAL_REQUIREMENTS_VERIFIED
 * All critical requirements must have passing verification.
 */
function evaluateCriticalRequirementsVerified(input: CompletionGateInput): GateResult {
  const criticalReqs = input.requirements.filter((r) => r.priority === "critical")

  if (criticalReqs.length === 0) {
    return createPass(CompletionGate.CRITICAL_REQUIREMENTS_VERIFIED, ["No critical requirements defined"])
  }

  const failures: string[] = []

  for (const req of criticalReqs) {
    const matchingResults = input.verificationResults.filter((r) => r.ruleId === req.id)

    const currentResults = matchingResults.filter(
      (r) =>
        !isResultStale(r, input.currentSha) &&
        r.runId === input.runId
    )

    const passingResults = currentResults.filter((r) => r.status === "passed")

    if (passingResults.length === 0) {
      const msg =
        currentResults.length === 0
          ? `Critical requirement "${req.description}" has no verification results`
          : `Critical requirement "${req.description}" has status: ${currentResults.map((r) => r.status).join(", ")}`
      failures.push(msg)
    }
  }

  if (failures.length > 0) {
    return createFail(
      CompletionGate.CRITICAL_REQUIREMENTS_VERIFIED,
      failures,
      { criticalRequirementsCount: criticalReqs.length, failedCount: failures.length }
    )
  }

  return createPass(CompletionGate.CRITICAL_REQUIREMENTS_VERIFIED, ["All critical requirements verified"])
}

/**
 * Evaluates Gate 5: REQUIRED_VERIFICATION_PASSED
 * All required verification checks must pass.
 */
function evaluateRequiredVerificationPassed(input: CompletionGateInput): GateResult {
  const requiredResults = input.verificationResults.filter((r) => r.required)

  if (requiredResults.length === 0) {
    return createPass(CompletionGate.REQUIRED_VERIFICATION_PASSED, ["No required verifications defined"])
  }

  const failures: string[] = []

  for (const result of requiredResults) {
    if (result.runId !== input.runId) {
      failures.push(`Required rule "${result.ruleDescription}" belongs to wrong run`)
      continue
    }

    if (isResultStale(result, input.currentSha)) {
      failures.push(`Required rule "${result.ruleDescription}" targets stale SHA ${result.targetSha}`)
      continue
    }

    if (result.status === "pending") {
      failures.push(`Required rule "${result.ruleDescription}" is pending`)
      continue
    }

    if (result.status === "running") {
      failures.push(`Required rule "${result.ruleDescription}" is still running`)
      continue
    }

    if (result.status === "skipped") {
      failures.push(`Required rule "${result.ruleDescription}" was skipped but passing is required`)
      continue
    }

    if (result.status === "failed") {
      failures.push(`Required rule "${result.ruleDescription}" failed`)
      continue
    }
  }

  if (failures.length > 0) {
    return createFail(
      CompletionGate.REQUIRED_VERIFICATION_PASSED,
      failures,
      { requiredCount: requiredResults.length, failedCount: failures.length }
    )
  }

  return createPass(CompletionGate.REQUIRED_VERIFICATION_PASSED, ["All required verifications passed"])
}

/**
 * Evaluates Gate 6: MANDATORY_EVIDENCE_PRESENT
 * All mandatory evidence artifacts must be present and SHA-matched.
 * Evidence requirements come from the contract (requiredEvidence), not caller-provided empty arrays.
 */
function evaluateMandatoryEvidencePresent(input: CompletionGateInput): GateResult {
  const failures: string[] = []

  // Check if the contract requires mandatory evidence
  const contractRequiresEvidence = input.requiredEvidence && input.requiredEvidence.length > 0

  // If contract requires evidence but caller provides empty array, reject
  if (input.evidenceItems.length === 0) {
    if (contractRequiresEvidence) {
      return createFail(
        CompletionGate.MANDATORY_EVIDENCE_PRESENT,
        ["Contract requires mandatory evidence but caller provided empty evidence array"],
        { requiredEvidenceCount: input.requiredEvidence!.length, evidenceCount: 0 }
      )
    }

    const hasEvidenceRefs = input.verificationResults.some((r) => r.evidenceIds.length > 0)
    if (hasEvidenceRefs) {
      return createFail(
        CompletionGate.MANDATORY_EVIDENCE_PRESENT,
        ["No evidence items exist but verification results reference evidence"],
        { evidenceCount: 0, verificationResultsWithEvidence: input.verificationResults.filter((r) => r.evidenceIds.length > 0).length }
      )
    }
    return createPass(CompletionGate.MANDATORY_EVIDENCE_PRESENT, ["No mandatory evidence required"])
  }

  // Filter to current (non-archived) evidence
  const currentEvidence = input.evidenceItems.filter((e) => e.status === "current")

  // Check if contract requires evidence and verify all required evidence exists
  if (contractRequiresEvidence) {
    for (const required of input.requiredEvidence!) {
      // Check if there's evidence matching the required type
      const hasMatchingEvidence = currentEvidence.some((ev) => {
        // For file evidence, also check path
        if (required.type === "file" && required.path) {
          return ev.sha === input.currentSha && ev.runId === input.runId
        }
        return ev.sha === input.currentSha && ev.runId === input.runId
      })

      if (!hasMatchingEvidence) {
        failures.push(`Required evidence of type "${required.type}" is missing or stale`)
      }
    }
  }

  // Validate evidence is not stale (SHA and runId match)
  for (const ev of currentEvidence) {
    if (ev.sha !== input.currentSha) {
      failures.push(`Evidence "${ev.id}" targets SHA ${ev.sha}, expected ${input.currentSha}`)
    }
    if (ev.runId !== input.runId) {
      failures.push(`Evidence "${ev.id}" belongs to run ${ev.runId}, expected ${input.runId}`)
    }
  }

  // Verify required verification results have current SHA-matched evidence
  for (const result of input.verificationResults) {
    if (result.required && result.status !== "skipped" && result.evidenceIds.length > 0) {
      const hasCurrentEvidence = result.evidenceIds.some((eid) => {
        const ev = input.evidenceItems.find((e) => e.id === eid)
        return (
          ev &&
          ev.status === "current" &&
          ev.sha === input.currentSha &&
          ev.runId === input.runId
        )
      })

      if (!hasCurrentEvidence) {
        failures.push(`Required result "${result.ruleDescription}" requires current SHA-matched evidence`)
      }
    }
  }

  if (failures.length > 0) {
    return createFail(
      CompletionGate.MANDATORY_EVIDENCE_PRESENT,
      failures,
      {
        evidenceCount: input.evidenceItems.length,
        currentEvidenceCount: currentEvidence.length,
        requiredEvidenceCount: contractRequiresEvidence ? input.requiredEvidence!.length : 0,
        failedCount: failures.length
      }
    )
  }

  return createPass(CompletionGate.MANDATORY_EVIDENCE_PRESENT, ["All mandatory evidence present and verified"])
}

/**
 * Evaluates all 6 gates and aggregates results.
 * Deterministic - same input always produces same output.
 */
export function evaluateAllGates(input: CompletionGateInput): AggregatedGateResult {
  const results: GateResult[] = [
    evaluateAssignmentsComplete(input),
    evaluateExactShaVerified(input),
    evaluateCriticalCriteriaPassed(input),
    evaluateCriticalRequirementsVerified(input),
    evaluateRequiredVerificationPassed(input),
    evaluateMandatoryEvidencePresent(input),
  ]

  const passedCount = results.filter((r) => r.passed).length
  const failingGates = results.filter((r) => !r.passed)

  return Object.freeze({
    allPassed: failingGates.length === 0,
    gateResults: Object.freeze([...results]),
    passedCount,
    totalCount: results.length,
    failingGates: Object.freeze([...failingGates]),
  })
}

/**
 * Evaluates a single gate by name.
 * Returns undefined if gate name is not recognized.
 */
export function evaluateGate(gate: CompletionGate, input: CompletionGateInput): GateResult {
  switch (gate) {
    case CompletionGate.ASSIGNMENTS_COMPLETE:
      return evaluateAssignmentsComplete(input)
    case CompletionGate.EXACT_SHA_VERIFIED:
      return evaluateExactShaVerified(input)
    case CompletionGate.CRITICAL_CRITERIA_PASSED:
      return evaluateCriticalCriteriaPassed(input)
    case CompletionGate.CRITICAL_REQUIREMENTS_VERIFIED:
      return evaluateCriticalRequirementsVerified(input)
    case CompletionGate.REQUIRED_VERIFICATION_PASSED:
      return evaluateRequiredVerificationPassed(input)
    case CompletionGate.MANDATORY_EVIDENCE_PRESENT:
      return evaluateMandatoryEvidencePresent(input)
    default:
      throw new Error(`Unknown completion gate: ${gate}`)
  }
}
