/**
 * Domain event definitions for the orchestration domain.
 *
 * Each event includes:
 * - event ID
 * - event type
 * - aggregate ID
 * - task run ID
 * - correlation ID
 * - causation ID
 * - occurred-at timestamp
 * - policy version
 * - payload
 */

export type DomainEventType =
  | "ApprovalRequested"
  | "ApprovalGranted"
  | "ApprovalRejected"
  | "ApprovalExpired"
  | "ApprovalRevoked"
  | "OverrideRequested"
  | "OverrideApproved"
  | "OverrideRejected"
  | "OverrideExpired"
  | "OverrideRevoked"
  | "CompletionEvaluated"
  | "CompletionBlocked"
  | "CompletionApproved"
  | "CompletionDecisionSuperseded"

export interface DomainEvent {
  readonly eventId: string
  readonly eventType: DomainEventType
  readonly aggregateId: string
  readonly taskRunId: string
  readonly correlationId: string
  readonly causationId?: string
  readonly occurredAt: Date
  readonly policyVersion: string
  readonly payload: Record<string, unknown>
}

export function createEvent(
  eventType: DomainEventType,
  aggregateId: string,
  taskRunId: string,
  correlationId: string,
  policyVersion: string,
  payload: Record<string, unknown>,
  causationId?: string,
): DomainEvent {
  return {
    eventId: `${eventType}-${aggregateId}-${Date.now()}`,
    eventType,
    aggregateId,
    taskRunId,
    correlationId,
    causationId,
    occurredAt: new Date(),
    policyVersion,
    payload: Object.freeze({ ...payload }),
  }
}
