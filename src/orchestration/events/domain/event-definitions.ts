/**
 * Domain event definitions.
 * occurredAt comes from the caller's injected clock — never generated internally.
 */

export type DomainEventType =
  | "ApprovalRequested" | "ApprovalGranted" | "ApprovalRejected"
  | "ApprovalExpired" | "ApprovalRevoked"
  | "OverrideRequested" | "OverrideApproved" | "OverrideRejected"
  | "OverrideExpired" | "OverrideRevoked" | "OverrideConsumed"
  | "CompletionEvaluated" | "CompletionBlocked" | "CompletionApproved" | "CompletionRejected"
  | "CompletionDecisionSuperseded"

export interface DomainEvent {
  readonly eventId: string
  readonly eventType: DomainEventType
  readonly eventVersion: number
  readonly aggregateType: string
  readonly aggregateId: string
  readonly aggregateVersion: number
  readonly taskRunId: string
  readonly contractFamilyId?: string
  readonly contractVersionId?: string
  readonly evaluatedSha?: string
  readonly correlationId: string
  readonly causationId?: string
  readonly occurredAt: string
  readonly policyVersion: string
  readonly actor: string
  readonly payload: Record<string, unknown>
}

let eventCounter = 0

export function createEvent(
  eventType: DomainEventType,
  aggregateId: string,
  taskRunId: string,
  correlationId: string,
  policyVersion: string,
  payload: Record<string, unknown>,
  occurredAt: string,
  causationId?: string,
  actor?: string,
  aggregateVersion?: number,
): DomainEvent {
  eventCounter++
  return Object.freeze({
    eventId: `${eventType}-${aggregateId}-${occurredAt}-${eventCounter}`,
    eventType,
    eventVersion: 1,
    aggregateType: eventType.includes("Approval") ? "Approval" :
      eventType.includes("Override") ? "Override" : "Completion",
    aggregateId,
    aggregateVersion: aggregateVersion ?? 1,
    taskRunId,
    correlationId,
    causationId,
    occurredAt,
    policyVersion,
    actor: actor ?? "system",
    payload: Object.freeze({ ...payload }),
  })
}
