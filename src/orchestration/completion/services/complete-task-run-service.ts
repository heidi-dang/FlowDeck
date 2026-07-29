/**
 * CompleteTaskRunService — atomic completion command.
 *
 * Transactional sequence (all inside UnitOfWork):
 * 1. Canonicalize and hash the full decision fingerprint
 * 2. Atomically reserve the scoped idempotency key
 * 3. Replay, reject conflict, or reject in-progress
 * 4. Load and validate required domain state
 * 5. Evaluate completion gates
 * 6. Validate approvals and overrides
 * 7. Persist evaluation
 * 8. Persist completion decision
 * 9. CAS-consume approved overrides
 * 10. Supersede previous decision when applicable
 * 11. Append domain events via event appender
 * 12. Mark idempotency reservation completed
 * 13. Commit once
 *
 * Any exception rolls back every step.
 * No external I/O inside the transaction.
 */

import { type CompleteTaskRunCommand, type CompleteTaskRunResult } from "../domain/completion-command"
import { type CompletionEvaluation } from "../domain/evaluation"
import type { CompletionEvaluationInput } from "./evaluation-service"
import { type CompletionDecision } from "../decision/completion-decision"
import { getCompletionPolicyVersion } from "../domain/policy-version"
import { CompletionDecisionService } from "./decision-service"
import { IdempotencyService } from "../../idempotency/domain/idempotency-service"
import { IdempotencyIntegrityError } from "../../idempotency/domain/errors"
import { type IdempotencyRepository } from "../../idempotency/ports/idempotency-repository"
import { type CompletionRepository } from "../ports/completion-repository"
import { type OverrideRepository } from "../../override/ports/override-repository"
import { type DomainEventAppender } from "../../events/ports/event-publisher"
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
    private readonly overrideRepository: OverrideRepository,
    private readonly eventAppender: DomainEventAppender,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(input: AtomicCompletionInput): Promise<CompleteTaskRunResult> {
    const { command, evaluationInput, overrides, approvalPairs, previousDecisionId } = input

    return this.unitOfWork.execute(async () => {
      // 1. Build the full decision fingerprint
      const fingerprint: Record<string, unknown> = {
        taskRunId: command.taskRunId,
        contractFamilyId: command.contractFamilyId,
        contractVersionId: command.contractVersionId,
        evaluatedSha: command.evaluatedSha,
        actor: command.actor,
        actorAuthority: command.actorAuthority,
        previousDecisionId: previousDecisionId ?? null,
        requiredAssignmentsComplete: evaluationInput.requiredAssignmentsComplete,
        currentSha: evaluationInput.currentSha,
        expectedRunId: evaluationInput.expectedRunId,
        requirementCount: evaluationInput.requirements.length,
        criteriaCount: evaluationInput.acceptanceCriteria.length,
        verificationResultCount: evaluationInput.verificationResults.length,
        evidenceCount: evaluationInput.evidenceItems.length,
        overrideIds: overrides.map((o) => o.id).sort(),
        overrideVersions: Object.fromEntries(overrides.map((o) => [o.id, o.version])),
        approvalRequestIds: approvalPairs.map((a) => a.request.id).sort(),
        approvalDecisionIds: approvalPairs.filter((a) => a.decision).map((a) => a.decision!.id).sort(),
        policyVersion: getCompletionPolicyVersion(),
      }

      // 2. Atomically reserve the scoped idempotency key
      const reservation = await this.idempotencyService.tryReserve(
        COMMAND_TYPE, command.taskRunId, command.idempotencyKey, fingerprint,
      )

      // 3. Handle non-acquired results
      if (reservation.status === "completed") {
        // Exact replay — load persisted result
        const record = reservation.record
        if (!record.resultId) throw new IdempotencyIntegrityError(record.scopedKey, "completed record has no resultId")

        const existingDecision = await this.completionRepository.getDecision(record.resultId)
        if (!existingDecision) {
          throw new IdempotencyIntegrityError(record.scopedKey, `decision ${record.resultId} not found`)
        }

        return {
          decision: existingDecision,
          evaluation: existingDecision.evaluation,
          events: Object.freeze([]),
          replayed: true,
        }
      }

      if (reservation.status === "in_progress") {
        throw new Error(`Command already in progress for key ${command.idempotencyKey}`)
      }

      if (reservation.status === "conflict") {
        const { IdempotencyConflictError } = await import("../../idempotency/domain/errors")
        throw new IdempotencyConflictError(
          `${COMMAND_TYPE}:${command.taskRunId}:${command.idempotencyKey}`,
          reservation.expectedPayloadHash,
          reservation.actualPayloadHash,
        )
      }

      // reservation.status === "acquired" — proceed

      try {
        // 4-6. Evaluate and decide (gates, overrides, approvals)
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

        // 7. Persist evaluation
        await this.completionRepository.saveEvaluation(evaluation)

        // 8. Persist completion decision
        await this.completionRepository.saveDecision(decision)

        // 9. CAS-consume approved overrides
        for (const overrideId of consumedOverrideIds) {
          const ov = (overrides as OverrideRequest[]).find((o) => o.id === overrideId)
          if (ov) {
            await this.overrideRepository.consume(overrideId, decision.id, ov.version, command.requestedAt)
          }
        }

        // 10. Supersede previous decision when applicable
        if (previousDecisionId) {
          await this.completionRepository.supersedeDecision(previousDecisionId, decision.id)
        }

        // 11. Generate and append domain events
        const events = this.generateEvents(decision, evaluation, command, consumedOverrideIds, overrides as OverrideRequest[])
        await this.eventAppender.appendMany(events)

        // 12. Mark idempotency reservation completed
        await this.idempotencyService.complete(
          COMMAND_TYPE, command.taskRunId, command.idempotencyKey,
          "completion_decision", decision.id,
        )

        return {
          decision,
          evaluation,
          events: Object.freeze(events),
          replayed: false,
        }
      } catch (err) {
        // On failure, release the idempotency reservation
        try {
          await this.idempotencyService.release(COMMAND_TYPE, command.taskRunId, command.idempotencyKey)
        } catch { /* release best-effort */ }
        throw err
      }
    })
  }

  private generateEvents(
    decision: CompletionDecision,
    evaluation: CompletionEvaluation,
    command: CompleteTaskRunCommand,
    consumedOverrideIds: readonly string[],
    consumedOverrides: readonly OverrideRequest[],
  ): DomainEvent[] {
    const events: DomainEvent[] = []
    const policyVersion = getCompletionPolicyVersion()

    // CompletionEvaluated — always emitted
    events.push(createEvent(
      "CompletionEvaluated", decision.id, command.taskRunId,
      command.correlationId, policyVersion, {
        taskRunId: command.taskRunId,
        contractFamilyId: command.contractFamilyId,
        contractVersionId: command.contractVersionId,
        evaluatedSha: command.evaluatedSha,
        allPassed: evaluation.allPassed,
        gateCount: evaluation.totalGates,
        passedGates: evaluation.passedGates,
        policyVersion,
      },
      undefined, command.actor, 1,
    ))

    // Terminal event based on outcome
    if (decision.outcome === "completed") {
      events.push(createEvent(
        "CompletionApproved", decision.id, command.taskRunId,
        command.correlationId, policyVersion, {
          decisionId: decision.id,
          outcome: decision.outcome,
          appliedOverrideIds: [...decision.appliedOverrideIds],
          approvalIds: [...decision.approvalIds],
          policyVersion,
        },
        undefined, command.actor, 1,
      ))
    } else if (decision.outcome === "blocked") {
      events.push(createEvent(
        "CompletionBlocked", decision.id, command.taskRunId,
        command.correlationId, policyVersion, {
          decisionId: decision.id,
          outcome: decision.outcome,
          failureReasons: [...decision.failureReasons],
          policyVersion,
        },
        undefined, command.actor, 1,
      ))
    } else if (decision.outcome === "rejected") {
      events.push(createEvent(
        "CompletionRejected", decision.id, command.taskRunId,
        command.correlationId, policyVersion, {
          decisionId: decision.id,
          outcome: decision.outcome,
          failureReasons: [...decision.failureReasons],
          policyVersion,
        },
        undefined, command.actor, 1,
      ))
    }

    // OverrideConsumed — one per consumed override
    for (const overrideId of consumedOverrideIds) {
      const ov = consumedOverrides.find((o) => o.id === overrideId)
      events.push(createEvent(
        "OverrideConsumed", overrideId, command.taskRunId,
        command.correlationId, policyVersion, {
          overrideId,
          decisionId: decision.id,
          previousVersion: ov?.version ?? 0,
          newVersion: (ov?.version ?? 0) + 1,
          consumedAt: command.requestedAt,
          taskRunId: command.taskRunId,
        },
        undefined, command.actor, (ov?.version ?? 0) + 1,
      ))
    }

    return events
  }
}
