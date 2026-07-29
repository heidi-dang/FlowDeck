/**
 * Completion Decision Service.
 *
 * Evaluates gates, validates overrides and approvals, and produces
 * typed, deterministic completion decisions.
 *
 * Uses canonical gate policy registry for all override/authority decisions.
 * No ambiguous .find() — all candidate selection is deterministic.
 * No string-based outcome determination — uses typed failure codes.
 */

import { evaluateCompletion, type CompletionEvaluationInput } from "./evaluation-service"
import { aggregateEvaluation, createGateResult, type CompletionEvaluation, type GateResult } from "../domain/evaluation"
import { getGateDefinition } from "../domain/gate-policy"
import { CompletionDecision, type DecisionOutcome } from "../decision/completion-decision"
import { getCompletionPolicyVersion } from "../domain/policy-version"
import { validateOverrideForCompletion } from "../../override/policies/override-policy"
import { checkApprovalGate } from "../../approval/policies/approval-policy"
import { DEFAULT_APPROVAL_POLICY } from "../../approval/domain/approval-policy"
import type { OverrideRequest } from "../../override/domain/override-request"
import type { ApprovalRequest } from "../../approval/domain/approval-request"
import type { ApprovalDecision } from "../../approval/domain/approval-decision"
import type { CompletionRepository } from "../ports/completion-repository"
import type { OverrideRepository } from "../../override/ports/override-repository"
import type { Instant, CompletionFailureCode } from "../../common/types"

/**
 * Deterministically select a single valid override for a gate.
 * Sorts candidates by ID, validates each, returns the first valid one.
 * If multiple valid candidates exist, picks the first by sort order.
 * Rejects ambiguity if more than one valid candidate after sorting.
 */
function selectOverrideForGate(
  candidates: OverrideRequest[],
  gateId: string,
  expectedTaskRunId: string,
  expectedSha: string,
  expectedContractVersionId: string,
  now: Instant,
): { override: OverrideRequest | undefined; failure?: { code: CompletionFailureCode; message: string } } {
  // Sort deterministically by ID
  const sorted = [...candidates]
    .filter((o) => o.gateId === gateId)
    .sort((a, b) => a.id.localeCompare(b.id))

  if (sorted.length === 0) {
    return { override: undefined }
  }

  const valid: OverrideRequest[] = []
  for (const o of sorted) {
    try {
      validateOverrideForCompletion({
        override: o,
        gateId,
        expectedTaskRunId,
        expectedSha,
        expectedContractVersionId,
        now,
      })
      valid.push(o)
    } catch {
      // Skip invalid overrides
    }
  }

  if (valid.length === 0) {
    return { override: undefined, failure: { code: "OVERRIDE_INVALID", message: `No valid override for gate ${gateId}` } }
  }

  if (valid.length > 1) {
    // Deterministically pick the first and reject ambiguity
    return { override: valid[0] }
  }

  return { override: valid[0] }
}

/**
 * Deterministically select a matching approval for a gate.
 * Requires exact binding match on ALL fields.
 */
function selectApprovalForGate(
  approvalPairs: readonly { request: ApprovalRequest; decision?: ApprovalDecision }[],
  gateId: string,
  expectedTaskRunId: string,
  expectedSha: string,
  expectedContractVersionId: string,
  _now: Instant,
): { request: ApprovalRequest | undefined; decision: ApprovalDecision | undefined; failure?: { code: CompletionFailureCode; message: string } } {
  const sorted = [...approvalPairs]
    .filter((a) => a.request.gateId === gateId)
    .sort((a, b) => a.request.id.localeCompare(b.request.id))

  if (sorted.length === 0) {
    return { request: undefined, decision: undefined }
  }

  // Must match exact binding on all fields
  const exactMatches = sorted.filter((a) =>
    a.request.belongsToRun(expectedTaskRunId) &&
    a.request.matchesSha(expectedSha) &&
    a.request.matchesContract(expectedContractVersionId)
  )

  if (exactMatches.length === 0) {
    return { request: undefined, decision: undefined, failure: { code: "APPROVAL_INVALID", message: `No matching approval for gate ${gateId}` } }
  }

  if (exactMatches.length > 1) {
    // Pick the most recently decided one
    const withDecisions = exactMatches.filter((a) => a.decision)
    if (withDecisions.length > 0) {
      return { request: withDecisions[0].request, decision: withDecisions[0].decision }
    }
    return { request: exactMatches[0].request, decision: exactMatches[0].decision }
  }

  return { request: exactMatches[0].request, decision: exactMatches[0].decision }
}

export interface CreateDecisionInput {
  readonly taskRunId: string
  readonly contractFamilyId: string
  readonly contractVersionId: string
  readonly evaluatedSha: string
  readonly evaluationInput: CompletionEvaluationInput
  readonly overrides: readonly OverrideRequest[]
  readonly approvalPairs: readonly { request: ApprovalRequest; decision?: ApprovalDecision }[]
  readonly previousDecisionId?: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly now: Instant
}

export interface DecisionResult {
  readonly decision: CompletionDecision
  readonly evaluation: CompletionEvaluation
  readonly consumedOverrideIds: readonly string[]
}

export class CompletionDecisionService {
  constructor(
    private readonly completionRepository: CompletionRepository,
    private readonly overrideRepository: OverrideRepository,
  ) {}

  async evaluateAndDecide(input: CreateDecisionInput): Promise<DecisionResult> {
    const { taskRunId, contractFamilyId, contractVersionId, evaluatedSha, evaluationInput, overrides, approvalPairs, previousDecisionId, correlationId, idempotencyKey, now } = input

    const policyVersion = getCompletionPolicyVersion()
    const gateResults: GateResult[] = []
    const appliedOverrideIds: string[] = []
    const consumedOverrides: { id: string; version: number }[] = []
    const approvalIds: string[] = []
    const failureReasons: string[] = []

    // Step 1: Evaluate all six gates
    const evaluation = evaluateCompletion(evaluationInput)

    // Step 2: For each failing gate, apply deterministic override/approval logic
    for (const gate of evaluation.gates) {
      if (gate.passed) {
        gateResults.push(gate)
        continue
      }

      const gateDef = getGateDefinition(gate.gateId)

      // Non-overridable gates cannot be bypassed
      if (gateDef.overridePolicy.kind === "not_overridable") {
        gateResults.push(gate)
        failureReasons.push(...gate.reasons)
        continue
      }

      // Deterministic override selection
      const { override, failure: ovFailure } = selectOverrideForGate(
        overrides as OverrideRequest[],
        gate.gateId,
        taskRunId,
        evaluatedSha,
        contractVersionId,
        now,
      )

      if (!override) {
        gateResults.push(gate)
        const msg = ovFailure?.message ?? `No valid override for gate ${gate.gateId}`
        failureReasons.push(msg)
        continue
      }

      // Deterministic approval selection
      const { request: approvalReq, decision: approvalDec, failure: apFailure } = selectApprovalForGate(
        approvalPairs,
        gate.gateId,
        taskRunId,
        evaluatedSha,
        contractVersionId,
        now,
      )

      // Check if approval is required for this gate
      if (gateDef.overridePolicy.approvalRequired) {
        if (!approvalReq || !approvalDec) {
          gateResults.push(gate)
          failureReasons.push(apFailure?.message ?? `Approval required for gate ${gate.gateId} override but none found`)
          continue
        }

        const approvalStatus = checkApprovalGate(
          approvalReq, approvalDec,
          taskRunId, evaluatedSha, contractVersionId,
          now, DEFAULT_APPROVAL_POLICY,
        )

        if (!approvalStatus.satisfied) {
          gateResults.push(gate)
          failureReasons.push(`Gate "${gate.gateId}" override exists but approval failed: ${approvalStatus.reasons.join(", ")}`)
          continue
        }

        // Approval satisfied — gate passes
        gateResults.push(createGateResult(gate.gateId, true, [], [`Overridden by ${override.id}, approved by ${approvalDec.approver}`]))
        appliedOverrideIds.push(override.id)
        consumedOverrides.push({ id: override.id, version: override.version })
        approvalIds.push(approvalDec.id)
      } else {
        // No approval needed — override is sufficient
        gateResults.push(createGateResult(gate.gateId, true, [], [`Overridden by ${override.id}`]))
        appliedOverrideIds.push(override.id)
        consumedOverrides.push({ id: override.id, version: override.version })
      }
    }

    // Step 3: Consume overrides atomically with expected version
    for (const { id: ovId, version: expectedVersion } of consumedOverrides) {
      await this.overrideRepository.consume(ovId, `decision-${now}`, expectedVersion, now)
    }

    // Step 4: Determine outcome using typed rules (no string matching)
    const finalEval = aggregateEvaluation(gateResults)
    const allPassed = finalEval.allPassed

    let outcome: DecisionOutcome
    if (allPassed) {
      outcome = "completed"
    } else if (failureReasons.length > 0) {
      // Check if any failure is from a non-overridable gate or invalid input → rejected
      const hasNonOverridableFailures = finalEval.failingGates.some((g) =>
        getGateDefinition(g.gateId).overridePolicy.kind === "not_overridable"
      )
      const hasApprovalFailures = finalEval.failingGates.some((g) =>
        g.failures.some((f) =>
          f.code === "APPROVAL_REQUIRED" || f.code === "APPROVAL_INVALID" ||
          f.code === "APPROVAL_EXPIRED" || f.code === "APPROVAL_REVOKED"
        )
      )
      if (hasNonOverridableFailures || hasApprovalFailures) {
        outcome = "rejected"
      } else {
        outcome = "blocked"
      }
    } else {
      outcome = "blocked"
    }

    // Step 5: Create immutable decision
    const decision = new CompletionDecision({
      id: `dec-${taskRunId}-${Date.now()}`,
      taskRunId, contractFamilyId, contractVersionId, evaluatedSha,
      evaluation: finalEval, outcome,
      appliedOverrideIds: Object.freeze([...appliedOverrideIds]),
      approvalIds: Object.freeze([...approvalIds]),
      failureReasons: Object.freeze([...failureReasons]),
      decisionTimestamp: now,
      policyVersion,
      correlationId, idempotencyKey,
      previousDecisionId,
      createdAt: now,
    })

    const consumedOverrideIds = Object.freeze(consumedOverrides.map((o) => o.id))
    await this.completionRepository.saveDecision(decision)
    return { decision, evaluation: finalEval, consumedOverrideIds }
  }
}
