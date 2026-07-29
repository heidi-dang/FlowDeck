/**
 * CompleteTaskRunService — atomic completion command.
 *
 * Coordinates through a transaction port (implemented by Dev 1):
 * 1. Reserve idempotency key
 * 2. Load domain state
 * 3. Evaluate six gates
 * 4. Validate overrides and approvals
 * 5. Consume applicable overrides
 * 6. Persist evaluation
 * 7. Persist completion decision
 * 8. Persist idempotency result
 * 9. Append domain events
 * 10. Commit once
 *
 * No partial state remains if any step fails.
 * No external I/O inside the transaction.
 */

import { type CompleteTaskRunCommand, type CompleteTaskRunResult } from "../domain/completion-command"
import { type CompletionEvaluation } from "../domain/evaluation"
import type { CompletionEvaluationInput } from "./evaluation-service"
import { CompletionDecision } from "../decision/completion-decision"
import { getCompletionPolicyVersion } from "../domain/policy-version"
import { CompletionDecisionService } from "./decision-service"
import { IdempotencyService } from "../../idempotency/domain/idempotency-service"
import { type IdempotencyRepository } from "../../idempotency/ports/idempotency-repository"
import { type CompletionRepository } from "../ports/completion-repository"
import { type EventPublisher } from "../../events/ports/event-publisher"
import { type UnitOfWork } from "../../common/ports/unit-of-work"
import { createEvent, type DomainEvent } from "../../events/domain/event-definitions"
import type { OverrideRequest } from "../../override/domain/override-request"
import type { ApprovalRequest } from "../../approval/domain/approval-request"
import type { ApprovalDecision } from "../../approval/domain/approval-decision"

const COMMAND_TYPE = "completion.completeTaskRun"

export interface AtomicCompletionInput {
  readonly command: CompleteTaskRunCommand
  readonly evaluationInput: CompletionEvaluationInput
  readonly overrides: readonly OverrideRequest[]
  readonly approvalPairs: readonly { request: ApprovalRequest; decision?: ApprovalDecision }[]
  readonly previousDecisionId?: string
}

export class CompleteTaskRunService {
  constructor(
    private readonly decisionService: CompletionDecisionService,
    private readonly idempotencyService: IdempotencyService,
    private readonly idempotencyRepository: IdempotencyRepository,
    private readonly completionRepository: CompletionRepository,
    private readonly eventPublisher: EventPublisher,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(input: AtomicCompletionInput): Promise<CompleteTaskRunResult> {
    const { command, evaluationInput, overrides, approvalPairs, previousDecisionId } = input

    return this.unitOfWork.execute(async () => {
      // 1. Idempotency check
      const idemCheck = await this.idempotencyService.check(
        COMMAND_TYPE, command.taskRunId, command.idempotencyKey, {
          taskRunId: command.taskRunId,
          contractFamilyId: command.contractFamilyId,
          contractVersionId: command.contractVersionId,
          evaluatedSha: command.evaluatedSha,
        },
      )

      if (idemCheck.replayed && idemCheck.result) {
        // Fetch and return the existing decision
        const existingDecision = await this.completionRepository.getDecision(idemCheck.result.resultId)
        if (existingDecision) {
          const events: DomainEvent[] = []
          return {
            decision: existingDecision,
            evaluation: existingDecision.evaluation,
            events: Object.freeze(events),
            replayed: true,
          }
        }
      }

      // 2. Evaluate and decide (handles gates, overrides, approvals, and override consumption)
      const { decision, evaluation, consumedOverrideIds } = await this.decisionService.evaluateAndDecide({
        taskRunId: command.taskRunId,
        contractFamilyId: command.contractFamilyId,
        contractVersionId: command.contractVersionId,
        evaluatedSha: command.evaluatedSha,
        evaluationInput,
        overrides,
        approvalPairs,
        previousDecisionId,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        now: command.requestedAt,
      })

      // 3. Generate domain events
      const events = this.generateEvents(decision, evaluation, command, consumedOverrideIds)

      // 4. Persist idempotency result
      await this.idempotencyService.record(
        COMMAND_TYPE, command.taskRunId, command.idempotencyKey,
        { taskRunId: command.taskRunId, contractFamilyId: command.contractFamilyId, contractVersionId: command.contractVersionId, evaluatedSha: command.evaluatedSha },
        "completion_decision", decision.id,
      )

      // 5. Publish events (through port, inside transaction)
      await this.eventPublisher.publishMany(events)

      return {
        decision,
        evaluation,
        events: Object.freeze(events),
        replayed: false,
      }
    })
  }

  private generateEvents(
    decision: CompletionDecision,
    evaluation: CompletionEvaluation,
    command: CompleteTaskRunCommand,
    consumedOverrideIds: readonly string[],
  ): DomainEvent[] {
    const events: DomainEvent[] = []
    const policyVersion = getCompletionPolicyVersion()

    // Always emit CompletionEvaluated
    events.push(createEvent(
      "CompletionEvaluated", `evaluation-${command.taskRunId}`, command.taskRunId,
      command.correlationId, policyVersion, {
        taskRunId: command.taskRunId,
        allPassed: evaluation.allPassed,
        gateCount: evaluation.totalGates,
        passedGates: evaluation.passedGates,
      },
      undefined, command.actor,
    ))

    // Emit outcome-specific event
    if (decision.outcome === "completed") {
      events.push(createEvent(
        "CompletionApproved", decision.id, command.taskRunId,
        command.correlationId, policyVersion, {
          decisionId: decision.id,
          outcome: decision.outcome,
          appliedOverrideIds: [...decision.appliedOverrideIds],
          approvalIds: [...decision.approvalIds],
        },
        undefined, command.actor,
      ))
    } else if (decision.outcome === "blocked") {
      events.push(createEvent(
        "CompletionBlocked", decision.id, command.taskRunId,
        command.correlationId, policyVersion, {
          decisionId: decision.id,
          outcome: decision.outcome,
          failureReasons: [...decision.failureReasons],
        },
        undefined, command.actor,
      ))
    }

    // Emit OverrideConsumed for each consumed override
    for (const overrideId of consumedOverrideIds) {
      events.push(createEvent(
        "OverrideApproved", overrideId, command.taskRunId,
        command.correlationId, policyVersion, {
          overrideId,
          consumedByDecisionId: decision.id,
          taskRunId: command.taskRunId,
        },
        undefined, command.actor,
      ))
    }

    return events
  }
}
