/**
 * Domain event definitions.
 * Every event includes: event ID, version, aggregate type/ID/version,
 * task run, contract IDs, SHA, correlation/causation, timestamp, policy version, actor, payload.
 */

export type DomainEventType =
  | "ApprovalRequested" | "ApprovalGranted" | "ApprovalRejected"
  | "ApprovalExpired" | "ApprovalRevoked"
  | "OverrideRequested" | "OverrideApproved" | "OverrideRejected"
  | "OverrideExpired" | "OverrideRevoked" | "OverrideConsumed"
  | "CompletionEvaluated" | "CompletionBlocked" | "CompletionApproved"
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
  causationId?: string,
  actor?: string,
): DomainEvent {
  eventCounter++
  return Object.freeze({
    eventId: `${eventType}-${aggregateId}-${Date.now()}-${eventCounter}`,
    eventType,
    eventVersion: 1,
    aggregateType: eventType.includes("Approval") ? "Approval" :
      eventType.includes("Override") ? "Override" : "Completion",
    aggregateId,
    aggregateVersion: 1,
    taskRunId,
    correlationId,
    causationId,
    occurredAt: new Date().toISOString(),
    policyVersion,
    actor: actor ?? "system",
    payload: Object.freeze({ ...payload }),
  })
}
