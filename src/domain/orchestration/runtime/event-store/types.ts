export const EVENT_PAYLOAD_VERSIONS = { CURRENT: '1.0' as const };

/**
 * Typed event identifier provider
 */
export type EventIdGenerator = () => string;

/**
 * Uncommitted event (generic payload to be serialized)
 */
export interface UncommittedRuntimeEvent<T = unknown> {
  readonly eventId?: string;          // Optional until commit boundary
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly payload?: T;                // Typed payload (optional, derived from data in adapters)
  readonly metadata?: Record<string, unknown>;
  readonly commandId?: string;
  readonly correlationId?: string;
  readonly createdAt?: Date;
}

/**
 * Persisted event (must have all required fields after commit)
 */
export interface PersistedRuntimeEvent<T = unknown> {
  readonly eventId: string;            // Mandatory after commit
  readonly event: T;                   // The actual event object (typed)
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly globalSequence: number;
  readonly timestamp: Date;            // Mandatory after commit
  readonly payloadHash: string;
  readonly checksum: string;
  readonly committedAt: Date;
  readonly createdAt: Date;
  readonly metadata?: Record<string, unknown>;
  readonly commandId?: string;
  readonly correlationId?: string;
}

/**
 * Event payload type mapping
 */
export type RuntimeEventPayload = Record<string, unknown>;
export type RuntimeEventType = string;
export interface RunCreatedEventPayload { runId: string }
export interface RunStartedPlanningEventPayload {}
export interface RunCompletedPlanningEventPayload {}
export interface RunStartedAnalysisEventPayload {}
export interface RunCompletedAnalysisEventPayload {}
export interface RunStartedExecutionEventPayload {}
export interface RunCompletedExecutionEventPayload {}
export interface RunVerifiedEventPayload {}
export interface RunCompletedEventPayload {}
export interface RunFailedEventPayload { error: string }
export interface RunCancelledEventPayload { reason: string }
export interface RunRecoveredEventPayload {}
