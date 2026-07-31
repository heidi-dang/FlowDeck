/**
 * CompleteTaskRunCommand — the single atomic command boundary for completion.
 *
 * This is the Dev 2 domain application service entry point.
 * It coordinates all sub-domains through a transaction port.
 */

import type { Instant, IdempotencyKey, CorrelationId } from "../../common/types"
import type { CompletionEvaluation } from "./evaluation"
import type { CompletionDecision } from "../decision/completion-decision"
import type { DomainEvent } from "../../events/domain/event-definitions"

export interface CompleteTaskRunCommand {
  readonly taskRunId: string
  readonly contractFamilyId: string
  readonly contractVersionId: string
  readonly evaluatedSha: string
  readonly idempotencyKey: IdempotencyKey
  readonly correlationId: CorrelationId
  readonly actor: string
  readonly actorAuthority: string
  readonly requestedAt: Instant
}

export interface CompleteTaskRunResult {
  readonly decision: CompletionDecision
  readonly evaluation: CompletionEvaluation
  readonly events: readonly DomainEvent[]
  readonly replayed: boolean
}
