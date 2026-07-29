/**
 * In-Memory Event Store - Phase 3B Implementation
 * 
 * Provides a complete, testable implementation of RuntimeEventStorePort
 * with strict concurrency and duplicate handling
 */

import { UncommittedRuntimeEvent, PersistedRuntimeEvent, EVENT_PAYLOAD_VERSIONS } from './types';
import {
  RuntimeEventStorePort,
  AppendResult,
  DuplicateCheckResult,
  StreamPaginationOptions
} from './port';

/**
 * Pending events for failed appends (preserved for retry)
 */
interface PendingAppend {
  readonly appendId: string;
  readonly aggregateId: string;
  readonly events: UncommittedRuntimeEvent[];
  readonly expectedVersion: number;
  readonly startSequenceNumber?: number;
  readonly createdAt: Date;
}

/**
 * Simple SHA-256 implementation for payload hashing
 */
async function computePayloadHash(payload: unknown): Promise<string> {
  const jsonString = JSON.stringify(payload);
  const encoder = new TextEncoder();
  const data = encoder.encode(jsonString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Global sequence counter (monotonic across all streams)
 */
class GlobalSequenceCounter {
  private nextSequence = 1;

  next(): number {
    return this.nextSequence++;
  }

  current(): number {
    return this.nextSequence - 1;
  }
}

/**
 * In-memory event store implementation
 */
export class InMemoryRuntimeEventStore implements RuntimeEventStorePort {
  // Aggregate → persisted events
  private eventStreams = new Map<string, PersistedRuntimeEvent[]>();
  
  // Aggregate ID → version cache
  private versionCache = new Map<string, number>();

  // Event ID → event (for deduplication)
  private eventIndex = new Map<string, PersistedRuntimeEvent>();

  // Command ID → last seen (for idempotency)
  private commandIndex = new Map<string, string>(); // commandId → eventId

  // Pending appends (for rollback)
  private pendingAppends = new Map<string, PendingAppend>();

  // Global sequence
  private sequenceCounter = new GlobalSequenceCounter();

  // Known event types (enforce fail-closed)
  private knownEventTypes = new Set([
    'RunCreated', 'RunStartedPlanning', 'RunCompletedPlanning',
    'RunStartedAnalysis', 'RunCompletedAnalysis',
    'RunStartedExecution', 'RunCompletedExecution',
    'RunVerified', 'RunCompleted', 'RunFailed', 'RunCancelled', 'RunRecovered'
  ]);

  /**
   * Validate whether an append would succeed before attempting it
   */
  async validateAppend(aggregateId: string, expectedVersion: number): Promise<{ valid: true; actualVersion: number } | { valid: false; error: any }> {
    const actualVersion = this.versionCache.get(aggregateId) ?? 0;

    if (expectedVersion < actualVersion) {
      return {
        valid: false,
        error: createany('STALE_VERSION', aggregateId, expectedVersion, actualVersion)
      };
    }

    if (expectedVersion > actualVersion) {
      return {
        valid: false,
        error: createany('FUTURE_VERSION', aggregateId, expectedVersion, actualVersion)
      };
    }

    return { valid: true, actualVersion };
  }

  /**
   * Check for duplicate command or event
   */
  async checkDuplicate(event: UncommittedRuntimeEvent): Promise<DuplicateCheckResult> {
    // Check by command ID first
    if (event.commandId) {
      const existingEventId = this.commandIndex.get(event.commandId);
      if (existingEventId) {
        return { isDuplicate: true, existingCommand: event.commandId };
      }
    }

    // Check by event ID (if provided)
    if (event.eventId) {
      if (this.eventIndex.has(event.eventId)) {
        return { isDuplicate: true, existingEvent: this.eventIndex.get(event.eventId)! };
      }
    }

    return { isDuplicate: false };
  }

  /**
   * Atomic append of one or more events
   */
  async append(
    aggregateId: string,
    events: UncommittedRuntimeEvent[],
    expectedVersion: number,
    startSequenceNumber: number = 1
  ): Promise<AppendResult> {
    if (events.length === 0) {
      throw new Error('Cannot append empty event list');
    }

    // Validate expected version
    const validation = await this.validateAppend(aggregateId, expectedVersion);
    if (!validation.valid) {
      throw validation.error;
    }

    // Generate append ID for rollback tracking
    const appendId = `append_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Check for duplicates
    for (const event of events) {
      const dupResult = await this.checkDuplicate(event);
      if (dupResult.isDuplicate) {
        throw new Error(`Duplicate detected: ${dupResult.existingCommand ? `command ${dupResult.existingCommand}` : `event ${dupResult.existingEvent?.eventId}`}`);
      }
    }

    // Get next available sequences
    let currentSeq = startSequenceNumber;
    const assignedEvents: PersistedRuntimeEvent[] = [];

    // Process each event
    for (let i = 0; i < events.length; i++) {
      const uncommitted = events[i];
      const aggregateVersion = expectedVersion + i + 1; // Contiguous versioning
      
      // Verify global sequence monotonicity
      if (currentSeq <= this.sequenceCounter.current()) {
        throw new Error(`Global sequence violation: attempted ${currentSeq}, latest is ${this.sequenceCounter.current()}`);
      }

      // Compute hashes
      const payloadHash = await computePayloadHash(uncommitted.payload);
      const eventId = uncommitted.eventId ?? `evt_${aggregateId}_${aggregateVersion}_${Date.now()}`;
      
      // Create persisted event
      const persisted: PersistedRuntimeEvent = {
        ...uncommitted,
        eventId,
        globalSequence: currentSeq,
        aggregateVersion,
        committedAt: new Date(),
        createdAt: uncommitted.createdAt ?? new Date(),
        payloadHash,
        checksum: `${payloadHash}:${currentSeq}:${aggregateVersion}`
      };

      assignedEvents.push(persisted);
      currentSeq++;
    }

    // Perform atomic commit
    const existingStream = this.eventStreams.get(aggregateId) ?? [];
    const newStream = [...existingStream, ...assignedEvents];

    // Update indexes
    for (const event of assignedEvents) {
      this.eventIndex.set(eventId, event);
      if (event.commandId) {
        this.commandIndex.set(event.commandId, eventId);
      }
    }

    // Update stream and version
    this.eventStreams.set(aggregateId, newStream);
    this.versionCache.set(aggregateId, expectedVersion + events.length);

    // Clear pending (if any)
    this.pendingAppends.delete(appendId);

    return {
      appendedCount: events.length,
      nextExpectedVersion: expectedVersion + events.length,
      sequenceNumberStart: startSequenceNumber,
      events: assignedEvents
    };
  }

  /**
   * Rollback a failed append (preserves state up to failure point)
   */
  async rollback(appendId: string): Promise<void> {
    const pending = this.pendingAppends.get(appendId);
    if (!pending) {
      return; // Already rolled back or never started
    }

    // Remove events from this append
    const existingStream = this.eventStreams.get(pending.aggregateId) ?? [];
    const filteredStream = existingStream.filter(e => e.aggregateVersion <= pending.expectedVersion);
    
    this.eventStreams.set(pending.aggregateId, filteredStream);

    // Remove event/command indices from this append
    for (const event of pending.events) {
      if (event.eventId) {
        this.eventIndex.delete(eventId);
      }
      if (event.commandId) {
        this.commandIndex.delete(event.commandId);
      }
    }
  }

  /**
   * Read entire stream for rehydration
   */
  async readStream(
    aggregateId: string,
    options?: { fromRevision?: number; maxEvents?: number }
  ): Promise<PersistedRuntimeEvent[]> {
    const stream = this.eventStreams.get(aggregateId) ?? [];

    let result = stream;

    if (options?.fromRevision !== undefined) {
      result = result.filter(e => e.aggregateVersion >= ((options.fromRevision!) ?? 0));
    }

    if (options?.maxEvents !== undefined) {
      result = result.slice(0, options.maxEvents);
    }

    // Return immutable copy
    return result.map(e => ({ ...e }));
  }

  /**
   * Read global sequence range
   */
  async readGlobalRange(options: StreamPaginationOptions): Promise<{ events: PersistedRuntimeEvent[]; hasMore: boolean; lastSequenceNumber: number }> {
    const allEvents = Array.from(this.eventStreams.values()).flat();
    
    let sorted = [...allEvents].sort((a, b) => a.globalSequence! - b.globalSequence!);

    if (((options.fromRevision || 0) ?? 0) !== undefined) {
      sorted = sorted.filter(e => e.aggregateVersion >= ((options.fromRevision || 0) ?? 0));
    }

    if (((options.toRevision || 999999) ?? 999999) !== undefined) {
      sorted = sorted.filter(e => e.aggregateVersion <= ((options.toRevision || 999999) ?? 999999));
    }

    const limit = options.limit ?? 100;
    const sliced = sorted.slice(0, limit);
    const hasMore = sorted.length > limit;

    return {
      events: sliced.map(e => ({ ...e })),
      hasMore,
      lastSequenceNumber: sliced[sliced.length - 1]?.globalSequence ?? 0
    };
  }

  /**
   * Get current aggregate version
   */
  async getAggregateVersion(aggregateId: string): Promise<number> {
    return this.versionCache.get(aggregateId) ?? 0;
  }

  /**
   * Validate event type (fail closed for unknown)
   */
  async validateEventType(eventType: string): Promise<{ valid: true } | { valid: false; errors: string[] }> {
    const errors: string[] = [];

    if (!this.knownEventTypes.has(eventType)) {
      errors.push(`Unknown event type: ${eventType}`);
    }

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }

  /**
   * Get persisted event by ID
   */
  async getEventById(eventId: string): Promise<PersistedRuntimeEvent | undefined> {
    return this.eventIndex.get(event.eventId);
  }
}

// Helper to create typed concurrency error
function createany(
  type: any['type'],
  aggregateId: string,
  expectedVersion: number,
  actualVersion: number
): any {
  const messages: Record<any, string> = {
    STALE_VERSION: `Stale version: expected ${actualVersion}, got ${expectedVersion}`,
    FUTURE_VERSION: `Future version: expected ${actualVersion}, got ${expectedVersion}`,
    VERSION_GAP: `Version gap: expected contiguous version after ${actualVersion}, got ${expectedVersion}`
  };

  return {
    name: 'any',
    type,
    aggregateId,
    expectedVersion,
    actualVersion,
    message: messages[type]
  };
}
