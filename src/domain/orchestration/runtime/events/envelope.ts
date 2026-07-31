/**
 * Base event envelope for runtime domain
 */

/**
 * Event identity - globally unique per event instance
 */
export type EventId = string;

/**
 * Aggregate identity
 */
export type AggregateId = string;

/**
 * Aggregate version - optimistically concurrent control
 */
export type AggregateVersion = number;

/**
 * Global sequence number for event ordering
 * Immutable event sequence - never used timestamps as authoritative order
 */
export type GlobalSequence = number;

/**
 * Event type identifier
 */
export type EventType = string;

/**
 * Payload version for event schema evolution
 */
export type PayloadVersion = string;

/**
 * Causation ID - tracks causal chain of events
 */
export type CausationId = string;

/**
 * Correlation ID - groups related events across aggregates
 */
export type CorrelationId = string;

/**
 * Command ID - idempotency key for command deduplication
 */
export type CommandId = string;

/**
 * Metadata for event creation time (not authoritative ordering)
 */
export interface CreationMetadata {
  createdAt: Date;
  createdAtTs: number;
}

/**
 * Base event envelope
 */
export interface DomainEvent<TPayload = unknown> extends CreationMetadata {
  readonly id: EventId;
  readonly aggregateId: AggregateId;
  readonly aggregateVersion: AggregateVersion;
  readonly globalSequence?: GlobalSequence;
  readonly type: EventType;
  readonly payloadVersion: PayloadVersion;
  readonly payload: TPayload;
  readonly causationId?: CausationId;
  readonly correlationId: CorrelationId;
  readonly commandId?: CommandId;
}
