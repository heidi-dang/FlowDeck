/**
 * CompletionDecision — durable, immutable, deeply frozen decision record.
 * Contains the full evaluation snapshot and all applied overrides/approvals.
 * Once created, a decision is never mutated.
 */

import type { CompletionEvaluation } from "../domain/evaluation"
import type { Instant, PolicyVersion } from "../../common/types"

export type DecisionOutcome = "completed" | "blocked" | "rejected" | "superseded"

export interface CompletionDecisionData {
  readonly id: string
  readonly taskRunId: string
  readonly contractFamilyId: string
  readonly contractVersionId: string
  readonly evaluatedSha: string
  readonly evaluation: CompletionEvaluation
  readonly outcome: DecisionOutcome
  readonly appliedOverrideIds: readonly string[]
  readonly approvalIds: readonly string[]
  readonly failureReasons: readonly string[]
  readonly decisionTimestamp: Instant
  readonly policyVersion: PolicyVersion
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly previousDecisionId?: string
  readonly createdAt: Instant
}

export class CompletionDecision {
  public readonly id: string
  public readonly taskRunId: string
  public readonly contractFamilyId: string
  public readonly contractVersionId: string
  public readonly evaluatedSha: string
  public readonly evaluation: CompletionEvaluation
  public readonly outcome: DecisionOutcome
  public readonly appliedOverrideIds: readonly string[]
  public readonly approvalIds: readonly string[]
  public readonly failureReasons: readonly string[]
  public readonly decisionTimestamp: Instant
  public readonly policyVersion: PolicyVersion
  public readonly correlationId: string
  public readonly idempotencyKey: string
  public readonly previousDecisionId?: string
  public readonly createdAt: Instant

  constructor(data: CompletionDecisionData) {
    this.id = data.id; this.taskRunId = data.taskRunId
    this.contractFamilyId = data.contractFamilyId; this.contractVersionId = data.contractVersionId
    this.evaluatedSha = data.evaluatedSha; this.evaluation = data.evaluation
    this.outcome = data.outcome
    this.appliedOverrideIds = Object.freeze([...data.appliedOverrideIds])
    this.approvalIds = Object.freeze([...data.approvalIds])
    this.failureReasons = Object.freeze([...data.failureReasons])
    this.decisionTimestamp = data.decisionTimestamp; this.policyVersion = data.policyVersion
    this.correlationId = data.correlationId; this.idempotencyKey = data.idempotencyKey
    this.previousDecisionId = data.previousDecisionId; this.createdAt = data.createdAt
    Object.freeze(this) // shallow freeze; evaluation is separately deep-frozen in aggregateEvaluation
  }
}
