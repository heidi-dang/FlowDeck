/**
 * CompleteTaskRunService — atomic completion command.
 *
 * Transactional sequence:
 * 1. Build full canonical fingerprint of all decision inputs
 * 2. Atomically reserve the scoped idempotency key
 * 3. Replay, reject conflict (typed), or reject in-progress (typed)
 * 4. Evaluate completion gates
 * 5. Validate approvals and overrides
 * 6. Persist evaluation
 * 7. Persist completion decision
 * 8. CAS-consume approved overrides (throw typed error if override not found)
 * 9. Supersede previous decision (with validation)
 * 10. Append domain events
 * 11. Complete idempotency reservation
 * 12. Commit once
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
import { IdempotencyIntegrityError, IdempotencyInProgressError, IdempotencyConflictError } from "../../idempotency/domain/errors"
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

/** Error thrown when a consumed override ID cannot be found. */
export class MissingConsumedOverrideError extends Error {
  public readonly code = "MISSING_CONSUMED_OVERRIDE"
  constructor(overrideId: string) {
    super(`Consumed override ${overrideId} not found in input overrides — aborting transaction`)
    this.name = "MissingConsumedOverrideError"
  }
}

/** Error thrown when supersession validation fails. */
export class SupersessionError extends Error {
  public readonly code = "SUPERSESSION_FAILED"
  public readonly detail: string
  constructor(detail: string) {
    super(`Supersession failed: ${detail}`)
    this.detail = detail
    this.name = "SupersessionError"
  }
}

export interface AtomicCompletionInput {
  readonly command: CompleteTaskRunCommand
  readonly evaluationInput: CompletionEvaluationInput
  readonly overrides: readonly OverrideRequest[]
  readonly approvalPairs: readonly { request: ApprovalRequest; decision?: ApprovalDecision }[]
  readonly previousDecisionId?: string
}

function buildFingerprint(
  command: CompleteTaskRunCommand,
  evaluationInput: CompletionEvaluationInput,
  overrides: readonly OverrideRequest[],
  approvalPairs: readonly { request: ApprovalRequest; decision?: ApprovalDecision }[],
  previousDecisionId: string | undefined,
): Record<string, unknown> {
  return {
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
    // Full canonical projections — not counts
    requirements: evaluationInput.requirements.map((r) => ({
      id: r.id, description: r.description, priority: r.priority,
    })),
    acceptanceCriteria: evaluationInput.acceptanceCriteria.map((a) => ({
      id: a.id, description: a.description, priority: a.priority,
    })),
    verificationResults: evaluationInput.verificationResults.map((vr) => ({
      id: (vr as any).id, ruleId: (vr as any).ruleId, status: (vr as any).status,
      required: (vr as any).required, targetSha: (vr as any).targetSha,
      runId: (vr as any).runId,
    })),
    evidenceItems: evaluationInput.evidenceItems.map((ev) => ({
      id: (ev as any).id, sha: (ev as any).sha, runId: (ev as any).runId,
      status: (ev as any).status, criterionIds: (ev as any).criterionIds,
    })),
    // Override details
    overrides: overrides.map((o) => ({
      id: o.id, gateId: o.gateId, version: o.version, status: o.status,
      sha: o.sha, taskRunId: o.taskRunId,
    })),
    // Approval details
    approvals: approvalPairs.map((a) => ({
      requestId: a.request.id, gateId: a.request.gateId, status: a.request.status,
      sha: a.request.sha, requester: a.request.requester,
      requesterAuthority: a.request.requesterAuthority,
      decision: a.decision ? {
        id: a.decision.id, outcome: a.decision.outcome,
        approver: a.decision.approver, approverAuthority: a.decision.approverAuthority,
      } : null,
    })),
    policyVersion: getCompletionPolicyVersion(),
  }
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

    // 1. Build the full decision fingerprint (canonical projections)
    const fingerprint = buildFingerprint(command, evaluationInput, overrides, approvalPairs, previousDecisionId)

    return this.unitOfWork.execute(async () => {
      // 2. Atomically reserve the scoped idempotency key
      const reservation = await this.idempotencyService.tryReserve(
        COMMAND_TYPE, command.taskRunId, command.idempotencyKey, fingerprint, command.requestedAt,
      )

      // 3. Handle non-acquired results with typed errors
      if (reservation.status === "completed") {
        const record = reservation.record
        if (!record.resultId) {
          throw new IdempotencyIntegrityError(record.scopedKey, "completed record has no resultId")
        }

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
        throw new IdempotencyInProgressError(`${COMMAND_TYPE}:${command.taskRunId}:${command.idempotencyKey}`)
      }

      if (reservation.status === "conflict") {
        throw new IdempotencyConflictError(
          `${COMMAND_TYPE}:${command.taskRunId}:${command.idempotencyKey}`,
          reservation.expectedPayloadHash,
          reservation.actualPayloadHash,
        )
      }

      // reservation.status === "acquired" — proceed
      try {
        // 4-5. Evaluate and decide (gates, overrides, approvals)
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

        // 6. Persist evaluation
        await this.completionRepository.saveEvaluation(evaluation)

        // 7. Persist completion decision
        await this.completionRepository.saveDecision(decision)

        // 8. CAS-consume approved overrides — never silently skip
        for (const overrideId of consumedOverrideIds) {
          const ov = overrides.find((o) => o.id === overrideId)
          if (!ov) {
            throw new MissingConsumedOverrideError(overrideId)
          }
          await this.overrideRepository.consume(overrideId, decision.id, ov.version, command.requestedAt)
        }

        // 9. Supersede previous decision with validation
        if (previousDecisionId) {
          await this.validateAndSupersede(previousDecisionId, decision, command)
        }

        // 10. Generate and append domain events
        const events = this.generateEvents(decision, evaluation, command, consumedOverrideIds, overrides)
        await this.eventAppender.appendMany(events)

        // 11. Complete idempotency reservation
        await this.idempotencyService.complete(
          COMMAND_TYPE, command.taskRunId, command.idempotencyKey,
          "completion_decision", decision.id, command.requestedAt,
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

  private async validateAndSupersede(
    previousDecisionId: string,
    newDecision: CompletionDecision,
    command: CompleteTaskRunCommand,
  ): Promise<void> {
    const prev = await this.completionRepository.getDecision(previousDecisionId)
    if (!prev) {
      throw new SupersessionError(`Previous decision ${previousDecisionId} not found`)
    }
    if (prev.taskRunId !== command.taskRunId) {
      throw new SupersessionError(`Previous decision belongs to run ${prev.taskRunId}, expected ${command.taskRunId}`)
    }
    if (prev.contractFamilyId !== command.contractFamilyId) {
      throw new SupersessionError(`Previous decision belongs to family ${prev.contractFamilyId}, expected ${command.contractFamilyId}`)
    }
    if (prev.contractVersionId !== command.contractVersionId) {
      throw new SupersessionError(`Previous decision belongs to version ${prev.contractVersionId}, expected ${command.contractVersionId}`)
    }
    if (prev.id === newDecision.id) {
      throw new SupersessionError("Cannot supersede self")
    }
    // Check not already superseded by looking up the supersession chain
    // (actual persistence check would be in repository)
    await this.completionRepository.supersedeDecision(previousDecisionId, newDecision.id)
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
    const timestamp = command.requestedAt

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
      timestamp, undefined, command.actor, 1,
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
        timestamp, undefined, command.actor, 1,
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
        timestamp, undefined, command.actor, 1,
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
        timestamp, undefined, command.actor, 1,
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
          consumedAt: timestamp,
          taskRunId: command.taskRunId,
        },
        timestamp, undefined, command.actor, (ov?.version ?? 0) + 1,
      ))
    }

    return events
  }
}
