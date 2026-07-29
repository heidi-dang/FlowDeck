/**
 * Completion Decision Service.
 *
 * Integrates the six-gate evaluation, override policy, and approval gates
 * into a durable, immutable, versioned completion decision.
 *
 * Idempotency is handled by the caller (see idempotency service).
 */

import { evaluateCompletion, type CompletionEvaluationInput } from "./evaluation-service"
import { aggregateEvaluation, createGateResult, type CompletionEvaluation, type GateResult } from "../domain/evaluation"
import { CompletionDecision, type DecisionOutcome } from "../decision/completion-decision"
import { getCompletionPolicyVersion } from "../domain/policy-version"
import { getGateOverrideability, validateOverrideForCompletion } from "../../override/policies/override-policy"
import { checkApprovalGate } from "../../approval/policies/approval-policy"
import type { OverrideRequest } from "../../override/domain/override-request"
import type { ApprovalRequest } from "../../approval/domain/approval-request"
import type { ApprovalDecision } from "../../approval/domain/approval-decision"
import type { CompletionRepository } from "../ports/completion-repository"
import type { IdGenerator } from "../../common/ports/id-generator"

export interface CreateDecisionInput {
  readonly taskRunId: string
  readonly contractFamilyId: string
  readonly contractVersionId: string
  readonly evaluatedSha: string
  readonly evaluationInput: CompletionEvaluationInput
  readonly overrides: readonly OverrideRequest[]
  readonly approvalRequests: readonly { request: ApprovalRequest; decision?: ApprovalDecision }[]
  readonly previousDecisionId?: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly now: Date
}

export interface DecisionResult {
  readonly decision: CompletionDecision
  readonly evaluation: CompletionEvaluation
}

export class CompletionDecisionService {
  constructor(
    private readonly repository: CompletionRepository,
  ) {}

  async evaluateAndDecide(input: CreateDecisionInput, idGen: IdGenerator): Promise<DecisionResult> {
    const { taskRunId, contractFamilyId, contractVersionId, evaluatedSha, evaluationInput, overrides, approvalRequests, previousDecisionId, correlationId, idempotencyKey, now } = input

    const policyVersion = getCompletionPolicyVersion()
    const gateResults: GateResult[] = []
    const appliedOverrideIds: string[] = []
    const approvalIds: string[] = []
    const failureReasons: string[] = []

    // Step 1: Evaluate all six gates
    const evaluation = evaluateCompletion(evaluationInput)

    // Step 2: For each failing gate, check overrides and approvals
    for (const gate of evaluation.gates) {
      if (gate.passed) {
        gateResults.push(gate)
        continue
      }

      const overrideability = getGateOverrideability(gate.gateId)

      // Non-overridable gates cannot be bypassed
      if (overrideability === "not_overridable") {
        gateResults.push(gate)
        failureReasons.push(`Gate "${gate.gateId}" cannot be overridden: ${gate.reasons.join(", ")}`)
        continue
      }

      // Look for a valid override
      const matchingOverride = overrides.find(
        (o) => o.gateId === gate.gateId && o.belongsToRun(taskRunId) && o.matchesSha(evaluatedSha) && o.isActive
      )

      if (matchingOverride) {
        try {
          validateOverrideForCompletion({
            override: matchingOverride,
            gateId: gate.gateId,
            expectedTaskRunId: taskRunId,
            expectedSha: evaluatedSha,
            expectedContractVersionId: contractVersionId,
            now,
          })
          // Override is valid — check if we also need approval
          const matchingApproval = approvalRequests.find(
            (a) => a.request.gateId === gate.gateId && a.request.belongsToRun(taskRunId)
          )

          if (matchingApproval && matchingApproval.decision) {
            const approvalStatus = checkApprovalGate({
              request: matchingApproval.request,
              decision: matchingApproval.decision,
              expectedTaskRunId: taskRunId,
              expectedSha: evaluatedSha,
            _expectedContractVersionId: contractVersionId,
              now,
              allowSelfApproval: false,
            })

            if (approvalStatus.status === "satisfied") {
              gateResults.push(createGateResult(gate.gateId, true, [`Overridden by ${matchingOverride.id}, approved by ${matchingApproval.decision.approver}`]))
              appliedOverrideIds.push(matchingOverride.id)
              approvalIds.push(matchingApproval.decision.id)
            } else {
              gateResults.push(createGateResult(gate.gateId, false, [...gate.reasons, ...approvalStatus.reasons]))
              failureReasons.push(`Gate "${gate.gateId}" override exists but approval failed: ${approvalStatus.reasons.join(", ")}`)
            }
          } else {
            // Gate that requires escalated authority needs approval
            if (overrideability === "requires_escalated_authority") {
              gateResults.push(createGateResult(gate.gateId, false, [...gate.reasons, "Override requires escalated authority approval"]))
              failureReasons.push(`Gate "${gate.gateId}" requires escalated authority approval for override`)
            } else {
              gateResults.push(createGateResult(gate.gateId, true, [`Overridden by ${matchingOverride.id}`]))
              appliedOverrideIds.push(matchingOverride.id)
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error"
          gateResults.push(gate)
          failureReasons.push(`Gate "${gate.gateId}" override validation failed: ${message}`)
        }
      } else {
        // No valid override — gate remains failed
        gateResults.push(gate)
        failureReasons.push(...gate.reasons)
      }
    }

    // Step 3: Determine outcome
    const finalEval = aggregateEvaluation(gateResults)
    const allPassed = finalEval.allPassed

    let outcome: DecisionOutcome
    if (allPassed) {
      outcome = "completed"
    } else if (failureReasons.length > 0) {
      outcome = failureReasons.some((r) => r.includes("cannot be overridden") || r.includes("required approval"))
        ? "rejected"
        : "blocked"
    } else {
      outcome = "blocked"
    }

    // Step 4: Create immutable decision
    const decision = new CompletionDecision({
      id: idGen.generate(),
      taskRunId,
      contractFamilyId,
      contractVersionId,
      evaluatedSha,
      evaluation: finalEval,
      outcome,
      appliedOverrideIds: Object.freeze([...appliedOverrideIds]),
      approvalIds: Object.freeze([...approvalIds]),
      failureReasons: Object.freeze([...failureReasons]),
      decisionTimestamp: now,
      policyVersion,
      correlationId,
      idempotencyKey,
      previousDecisionId,
      createdAt: now,
    })

    await this.repository.saveDecision(decision)
    return { decision, evaluation: finalEval }
  }
}
