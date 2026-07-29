/**
 * Runtime Event Store Port - Phase 3B
 * 
 * Defines the append/read contracts for persistent event storage
 */

import { UncommittedRuntimeEvent, PersistedRuntimeEvent } from './types.js';

/**
 * Append result
 */
export interface AppendResult {
  readonly appendedCount: number;
  readonly nextExpectedVersion: number;
  readonly sequenceNumberStart: number; // First global sequence assigned
  readonly events: PersistedRuntimeEvent[];
}

/**
 * Concurrency error types
 */
export type ConcurrencyErrorType = 'STALE_VERSION' | 'FUTURE_VERSION' | 'VERSION_GAP';

/**
 * Concurrency error detail
 */
export interface ConcurrencyError {
  readonly name: 'ConcurrencyError';
  readonly type: ConcurrencyErrorType;
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  readonly message: string;
}

export function isConcurrencyError(error: unknown): error is ConcurrencyError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as ConcurrencyError).name === 'ConcurrencyError'
  );
}

/**
 * Duplicate detection result
 */
export interface DuplicateCheckResult {
  readonly isDuplicate: boolean;
  readonly existingEvent?: PersistedRuntimeEvent;
  readonly existingCommand?: string; // Command ID if duplicate command detected
}

/**
 * Stream pagination options
 */
export interface StreamPaginationOptions {
  readonly fromRevision?: number;
  readonly toRevision?: number;
  readonly limit: number;
  readonly resolveProjection?: boolean;
}

/**
 * Aggregate snapshot (optional future optimization)
 */
export interface AggregateSnapshot {
  readonly aggregateId: string;
  readonly version: number;
  readonly snapshotAt: Date;
  readonly payload: unknown; // Serialized state
}

/**
 * Runtime Event Store interface
 */
export interface RuntimeEventStorePort {
  /**
   * Validate whether an append would succeed before attempting it
   */
  validateAppend(aggregateId: string, expectedVersion: number): Promise<{
    valid: true;
    actualVersion: number;
  } | {
    valid: false;
    error: ConcurrencyError;
  }>;

  /**
   * Check for duplicate command/event
   */
  checkDuplicate(event: Omit<UncommittedRuntimeEvent<any>, 'eventId'>): Promise<DuplicateCheckResult>;

  /**
   * Atomic append of single or multiple events
   * Must either append all events or none
   * 
   * Requirements:
   * - Expected version must equal actual aggregate version
   * - No gaps in aggregate versions
   * - Global sequence numbers must be monotonic across ALL streams
   * - Duplicate event IDs fail
   * - Duplicate aggregate versions within same stream fail
   * - Unknown event types fail closed
   * - Unsupported payload versions fail closed
   */
  append(
    aggregateId: string,
    events: UncommittedRuntimeEvent[],
    expectedVersion: number,
    startSequenceNumber?: number
  ): Promise<AppendResult>;

  /**
   * Atomic rollback of failed append (preserves pending events)
   */
  rollback(appendId: string): Promise<void>;

  /**
   * Read entire stream for aggregate (used for rehydration)
   */
  readStream(
    aggregateId: string,
    options?: { fromRevision?: number; maxEvents?: number }
  ): Promise<PersistedRuntimeEvent[]>;

  /**
   * Read global sequence range (for replay)
   */
  readGlobalRange(
    options: StreamPaginationOptions
  ): Promise<{ events: PersistedRuntimeEvent[]; hasMore: boolean; lastSequenceNumber: number }>;

  /**
   * Get current aggregate version
   */
  getAggregateVersion(aggregateId: string): Promise<number>;

  /**
   * Ensure unknown/unsupported types fail closed
   */
  validateEventType(eventType: string): Promise<{
    valid: true;
  } | {
    valid: false;
    errors: string[];
  }>;

  /**
   * Get persisted event by ID (for duplicate detection)
   */
  getEventById(eventId: string): Promise<PersistedRuntimeEvent | undefined>;
}

// Re-export for convenience
export type { AppendResult, ConcurrencyError, DuplicateCheckResult };
