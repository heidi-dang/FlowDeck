/**
 * Runtime Event Types for Event Store Domain (Phase 3B)
 * 
 * Defines the uncommitted/persisted event models with strict versioning
 */

import { CreationMetadata, EventId, AggregateId, AggregateVersion } from '../../events/types.js';
import { TaskRunState } from './task-run.js';

/**
 * Payload versions for each event type
 */
export const EVENT_PAYLOAD_VERSIONS = {
  RUN_CREATED: '1.0',
  RUN_STARTED_PLANNING: '1.0',
  RUN_COMPLETED_PLANNING: '1.0',
  RUN_STARTED_ANALYSIS: '1.0',
  RUN_COMPLETED_ANALYSIS: '1.0',
  RUN_STARTED_EXECUTION: '1.0',
  RUN_COMPLETED_EXECUTION: '1.0',
  RUN_VERIFIED: '1.0',
  RUN_COMPLETED: '1.0',
  RUN_FAILED: '1.0',
  RUN_CANCELLED: '1.0',
  RUN_RECOVERED: '1.0'
} as const;

/**
 * Base payload for runtime events
 */
export interface RuntimeEventPayloadBase {
  readonly runId: string;
  readonly oldStatus?: TaskRunState;
  readonly newStatus: TaskRunState;
  readonly triggerCommand?: string;
  readonly correlationId?: string;
}

/**
 * Run created event
 */
export interface RunCreatedEventPayload extends RuntimeEventPayloadBase {
  readonly strategy: string;
  readonly planScope?: unknown;
  readonly initialVersion: number;
}

/**
 * Planning stage events
 */
export interface RunStartedPlanningEventPayload extends RuntimeEventPayloadBase {
  readonly planningStep?: string;
}

export interface RunCompletedPlanningEventPayload extends RuntimeEventPayloadBase {
  readonly planScope?: unknown;
  readonly analysisRequired: boolean;
}

/**
 * Analysis stage events
 */
export interface RunStartedAnalysisEventPayload extends RuntimeEventPayloadBase {
  readonly analysisTarget?: string;
  readonly analysisType?: string;
}

export interface RunCompletedAnalysisEventPayload extends RuntimeEventPayloadBase {
  readonly analysisResults?: unknown;
  readonly assignmentsCreated?: string[];
}

/**
 * Execution stage events
 */
export interface RunStartedExecutionEventPayload extends RuntimeEventPayloadBase {
  readonly delegationTarget?: string;
  readonly mode?: string;
}

export interface RunCompletedExecutionEventPayload extends RuntimeEventPayloadBase {
  readonly result?: unknown;
  readonly failureReason?: string;
}

/**
 * Verification stage events
 */
export interface RunVerifiedEventPayload extends RuntimeEventPayloadBase {
  readonly criteriaMet?: boolean;
  readonly acceptanceResult?: unknown;
}

/**
 * Terminal state events
 */
export interface RunCompletedEventPayload extends RuntimeEventPayloadBase {
  readonly finalOutcome?: unknown;
  readonly totalDuration?: number; // milliseconds
}

export interface RunFailedEventPayload extends RuntimeEventPayloadBase {
  readonly errorType: string;
  readonly errorMessage: string;
  readonly stackTrace?: string;
  readonly recoveryAttempted?: boolean;
}

export interface RunCancelledEventPayload extends RuntimeEventPayloadBase {
  readonly cancellationReason: string;
  readonly initiatedBy?: string;
}

/**
 * Recovery event
 */
export interface RunRecoveredEventPayload extends RuntimeEventPayloadBase {
  readonly recoveryPath?: string;
  readonly recoveredFrom?: TaskRunState;
}

/**
 * Union of all runtime event payloads
 */
export type RuntimeEventPayload =
  | RunCreatedEventPayload
  | RunStartedPlanningEventPayload
  | RunCompletedPlanningEventPayload
  | RunStartedAnalysisEventPayload
  | RunCompletedAnalysisEventPayload
  | RunStartedExecutionEventPayload
  | RunCompletedExecutionEventPayload
  | RunVerifiedEventPayload
  | RunCompletedEventPayload
  | RunFailedEventPayload
  | RunCancelledEventPayload
  | RunRecoveredEventPayload;

/**
 * Known runtime event types with their payloads
 */
export type RuntimeEventType = 
  | 'RunCreated'
  | 'RunStartedPlanning'
  | 'RunCompletedPlanning'
  | 'RunStartedAnalysis'
  | 'RunCompletedAnalysis'
  | 'RunStartedExecution'
  | 'RunCompletedExecution'
  | 'RunVerified'
  | 'RunCompleted'
  | 'RunFailed'
  | 'RunCancelled'
  | 'RunRecovered';

/**
 * Mapping of event type to payload
 */
export type RuntimeEventPayloadMap = {
  'RunCreated': RunCreatedEventPayload;
  'RunStartedPlanning': RunStartedPlanningEventPayload;
  'RunCompletedPlanning': RunCompletedPlanningEventPayload;
  'RunStartedAnalysis': RunStartedAnalysisEventPayload;
  'RunCompletedAnalysis': RunCompletedAnalysisEventPayload;
  'RunStartedExecution': RunStartedExecutionEventPayload;
  'RunCompletedExecution': RunCompletedExecutionEventPayload;
  'RunVerified': RunVerifiedEventPayload;
  'RunCompleted': RunCompletedEventPayload;
  'RunFailed': RunFailedEventPayload;
  'RunCancelled': RunCancelledEventPayload;
  'RunRecovered': RunRecoveredEventPayload;
};

/**
 * UncommittedRuntimeEvent - ready to be appended
 */
export interface UncommittedRuntimeEvent<T extends RuntimeEventType = RuntimeEventType> {
  readonly eventId?: EventId; // Assigned on commit
  readonly aggregateId: string;
  readonly expectedVersion: number; // BEFORE append (version before this event)
  readonly type: T;
  readonly payloadVersion: typeof EVENT_PAYLOAD_VERSIONS[T];
  readonly payload: RuntimeEventPayloadMap[T];
  readonly globalSequence?: number; // Assigned by persistence layer
  readonly createdAt?: Date; // Will be set by app layer
  readonly commandId?: string; // For idempotency
  readonly causationId?: string; // Parent event ID
  readonly correlationId?: string;
}

/**
 * PersistedRuntimeEvent - stored in event store
 */
export interface PersistedRuntimeEvent<T extends RuntimeEventType = RuntimeEventType> extends UncommittedRuntimeEvent<T>, CreationMetadata {
  readonly sequenceNumber: number; // Monotonically increasing global sequence
  readonly committedAt: Date; // Persisted timestamp
  readonly payloadHash: string; // SHA-256 hash of JSON payload
  readonly checksum: string; // Integrity checksum
}

/**
 * Helper to create uncommitted event
 */
export function createUncommittedEvent<T extends RuntimeEventType>(
  type: T,
  aggregateId: string,
  expectedVersion: number,
  payload: RuntimeEventPayloadMap[T],
  options?: {
    commandId?: string;
    causationId?: string;
    correlationId?: string;
    createdAt?: Date;
  }
): UncommittedRuntimeEvent<T> {
  return {
    eventId: undefined, // Will be assigned on commit
    aggregateId,
    expectedVersion,
    type,
    payloadVersion: EVENT_PAYLOAD_VERSIONS[type] as any,
    payload,
    globalSequence: options?.correlationId ? undefined : undefined, // Persistence assigns this
    createdAt: options?.createdAt ?? new Date(),
    commandId: options?.commandId,
    causationId: options?.causationId,
    correlationId: options?.correlationId
  };
}
