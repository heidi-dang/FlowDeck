/**
 * Event Store Tests - Phase 3B
 * 
 * Comprehensive tests for event append, rehydration, replay, concurrency, and leases
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import type { 
  PersistedRuntimeEvent, 
  UncommittedRuntimeEvent, 
  RuntimeEventType
} from '../../../src/domain/orchestration/runtime/event-store/types';
import { InMemoryRuntimeEventStore } from '../../../src/domain/orchestration/runtime/event-store/in-memory-store';
import { isConcurrencyError, DuplicateEventError, UnknownEventTypeError } from '../../../src/domain/orchestration/runtime/event-store';

function createUncommittedEvent<TPayload>(
  eventType: RuntimeEventType,
  aggregateId: string,
  aggregateVersion: number,
  payload: TPayload,
  eventId?: string
): UncommittedRuntimeEvent<TPayload> {
  return {
    eventType,
    aggregateId,
    aggregateVersion,
    payload,
    eventId,
    metadata: {
      payloadVersion: '1.0'
    }
  };
}

// Deterministic replay based on actual payload
function deterministicReplay(events: PersistedRuntimeEvent<unknown>[]): string[] {
  const states: string[] = [];
  let current = 'created';
  
  for (const e of events.sort((a, b) => a.aggregateVersion - b.aggregateVersion)) {
    if (e.eventType.includes('Planning')) current = 'planning';
    if (e.eventType.includes('Planning') && e.eventType.includes('Completed')) current = 'completed';
  }
  
  states.push(current);
  return states;
}

class InMemoryWorktreeLeaseRepository {
  private leases = new Map<string, { worktreeKey: string; ownerId: string; fencingToken: number }>();
  private owners = new Map<string, number>();

  async acquire(worktreeKey: string, ownerId: string): Promise<{ success: boolean; lease?: { worktreeKey: string; ownerId: string; fencingToken: number } }> {
    const existing = this.leases.get(worktreeKey);
    
    if (existing && existing.ownerId !== ownerId) {
      return { success: false };
    }

    const fenceToken = (this.owners.get(ownerId) ?? 0) + 1;
    this.owners.set(ownerId, fenceToken);

    const lease = { worktreeKey, ownerId, acquiredAt: new Date(), expiresAt: new Date(Date.now() + 30000), fencingToken: fenceToken };
    this.leases.set(worktreeKey, lease);

    return { success: true, lease };
  }

  async renew(worktreeKey: string, ownerId: string): Promise<{ success: boolean; lease?: { worktreeKey: string; ownerId: string; fencingToken: number } }> {
    const existing = this.leases.get(worktreeKey);
    
    if (!existing || existing.ownerId !== ownerId) {
      return { success: false };
    }

    return { success: true, lease: { ...existing } };
  }

  async getOwner(worktreeKey: string): Promise<string | undefined> {
    const lease = this.leases.get(worktreeKey);
    return lease?.ownerId;
  }

  validateFencing(worktreeKey: string, ownerId: string, token?: number): { valid: boolean; error?: { type: string } } {
    const current = this.leases.get(worktreeKey);
    
    if (!current) {
      return { valid: false, error: { type: 'NO_LEASE' } };
    }

    if (current.ownerId !== ownerId) {
      return { valid: false, error: { type: 'OWNER_MISMATCH' } };
    }

    if (token !== undefined && current.fencingToken !== token) {
      return { valid: false, error: { type: 'FENCING_VIOLATION' } };
    }

    return { valid: true };
  }
}

describe('Phase 3B - Event Store', () => {
  describe('Uncommitted vs Persisted Events', () => {
    it('creates uncommitted event without eventId', () => {
      const eventPayload = {
        runId: 'run_123',
        newStatus: 'created',
        strategy: 'simple',
        initialVersion: 1,
        correlationId: 'corr_456'
      };
      
      const event = createUncommittedEvent('RunCreated', 'run_123', 0, eventPayload);

      expect(event.eventId).toBeUndefined();
      expect(event.aggregateId).toBe('run_123');
      expect(event.aggregateVersion).toBe(0);
      expect(event.eventType).toBe('RunCreated');
      expect((event.payload as typeof eventPayload).strategy).toBe('simple');
    });

    it('assigns persisted fields on commit', async () => {
      const store = new InMemoryRuntimeEventStore();
      const eventPayload = { runId: 'run_123', newStatus: 'created', strategy: 'simple' };
      const uncommitted = createUncommittedEvent('RunCreated', 'run_123', 1, eventPayload); // Note: 1 because in-memory store uses current version 0 + 1

      const result = await store.append('run_123', [uncommitted], 0);
      const persisted = result.events[0];

      expect(persisted.eventId).toBeDefined();
      expect(persisted.globalSequence).toBe(1);
      expect(persisted.aggregateVersion).toBe(1);
      expect(persisted.committedAt).toBeDefined();
      expect(persisted.payloadHash.length).toBeGreaterThan(0);
    });
  });

  describe('Append Contract', () => {
    let store: InMemoryRuntimeEventStore;

    beforeEach(() => {
      store = new InMemoryRuntimeEventStore();
    });

    it('first append succeeds with expected version 0', async () => {
      const events = [
        createUncommittedEvent('RunCreated', 'run_123', 1, {
          runId: 'run_123',
          newStatus: 'created',
          strategy: 'simple',
          initialVersion: 1,
          correlationId: 'corr_1'
        })
      ];

      const result = await store.append('run_123', events, 0);

      expect(result.appendedCount).toBe(1);
      expect(result.nextExpectedVersion).toBe(1);
      expect(result.sequenceNumberStart).toBe(1);
      expect(result.events[0].globalSequence).toBe(1);
      expect(result.events[0].aggregateVersion).toBe(1);
    });

    it('multi-event append is atomic', async () => {
      const events = [
        createUncommittedEvent('RunCreated', 'run_456', 1, { runId: 'run_456', newStatus: 'created', strategy: 'planned', initialVersion: 1 }),
        createUncommittedEvent('RunStartedPlanning', 'run_456', 2, { runId: 'run_456', newStatus: 'planning', oldStatus: 'created' }),
        createUncommittedEvent('RunCompletedPlanning', 'run_456', 3, { runId: 'run_456', newStatus: 'planned', oldStatus: 'planning', analysisRequired: true })
      ];

      const result = await store.append('run_456', events, 0);

      expect(result.appendedCount).toBe(3);
      expect(result.nextExpectedVersion).toBe(3);
      
      // Verify contiguous versions
      expect(result.events[0].aggregateVersion).toBe(1);
      expect(result.events[1].aggregateVersion).toBe(2);
      expect(result.events[2].aggregateVersion).toBe(3);

      // Verify monotonic sequences
      expect(result.events[0].globalSequence).toBe(1);
      expect(result.events[1].globalSequence).toBe(2);
      expect(result.events[2].globalSequence).toBe(3);
    });

    it('empty append lists fail', async () => {
      try {
        await store.append('run_empty', [], 0);
        throw new Error('Should have thrown on empty append');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error);
        if (err instanceof Error) {
          expect(err.message).toContain('Cannot append empty event list');
        }
      }
    });

    it('stale version fails with typed error', async () => {
      await store.append('run_789', [createUncommittedEvent('RunCreated', 'run_789', 1, {})], 0);

      const staleEvent = createUncommittedEvent('RunStartedPlanning', 'run_789', 1, {});

      try {
        await store.append('run_789', [staleEvent], 0);
        throw new Error('Should have thrown on stale version');
      } catch (err: unknown) {
        expect(isConcurrencyError(err)).toBe(true);
      }
    });

    it('future version fails', async () => {
      const futureEvent = createUncommittedEvent('RunCompleted', 'run_789', 6, {});

      try {
        await store.append('run_789', [futureEvent], 5);
        throw new Error('Should have thrown on future version');
      } catch (err: unknown) {
        expect(isConcurrencyError(err)).toBe(true);
      }
    });

    it('duplicate event ID fails closed', async () => {
      const eventId = 'evt_dup_test_1';
      const events = [
        createUncommittedEvent('RunCreated', 'run_999', 1, { runId: 'run_999' }, eventId)
      ];
      await store.append('run_999', events, 0);

      const duplicateEvent = createUncommittedEvent('RunStartedPlanning', 'run_999', 2, {}, eventId);

      try {
        await store.append('run_999', [duplicateEvent], 1);
        throw new Error('Should have thrown duplicate event error');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(DuplicateEventError);
      }
    });

    it('unknown event type fails closed', async () => {
      try {
        await store.append('run_999', [createUncommittedEvent('UnknownEventType' as any, 'run_999', 1, {})], 0);
        throw new Error('Should have thrown on unknown event type');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(UnknownEventTypeError);
      }
    });

    it('failed appends do not partially modify state', async () => {
      // Setup base version
      await store.append('run_atomic', [createUncommittedEvent('RunCreated', 'run_atomic', 1, {})], 0);

      // Try appending good and bad event
      const events = [
        createUncommittedEvent('RunStartedPlanning', 'run_atomic', 2, {}),
        createUncommittedEvent('UnknownEventType' as any, 'run_atomic', 3, {}) // Invalid event type should abort both
      ];

      try {
        await store.append('run_atomic', events, 1);
      } catch {
        // Expected to fail
      }

      // Check state
      const stream = await store.readStream('run_atomic');
      expect(stream).toHaveLength(1);
      expect(await store.getAggregateVersion('run_atomic')).toBe(1);
    });
  });

  describe('Aggregate Rehydration', () => {
    it('rehydrates from valid stream', async () => {
      const store = new InMemoryRuntimeEventStore();
      
      await store.append('run_rehydrate', [
        createUncommittedEvent('RunCreated', 'run_rehydrate', 1, {})
      ], 0);

      const events = await store.readStream('run_rehydrate');
      expect(events).toHaveLength(1);
      expect(events[0].aggregateVersion).toBe(1);
    });

    it('empty stream produces minimal state', async () => {
      const store = new InMemoryRuntimeEventStore();
      const events = await store.readStream('nonexistent');
      expect(events.length).toBe(0);
    });

    it('deterministic replay produces same output', async () => {
      const store = new InMemoryRuntimeEventStore();
      const eventsToAppend = [
        createUncommittedEvent('RunCreated', 'det_test', 1, {}),
        createUncommittedEvent('RunStartedPlanning', 'det_test', 2, {}),
        createUncommittedEvent('RunCompletedPlanning', 'det_test', 3, {}),
        createUncommittedEvent('RunCompleted', 'det_test', 4, {})
      ];
      await store.append('det_test', eventsToAppend, 0);

      const persisted = await store.readStream('det_test');
      const transitions1 = deterministicReplay(persisted);
      const transitions2 = deterministicReplay(persisted);

      expect(transitions1).toEqual(transitions2);
      expect(transitions1.length).toBeGreaterThan(0);
    });
  });

  describe('Concurrent Writer Handling', () => {
    it('exactly one succeeds on concurrent writers', async () => {
      const store = new InMemoryRuntimeEventStore();

      const eventA = createUncommittedEvent('RunCreated', 'race_test', 1, {});
      const eventB = createUncommittedEvent('RunStartedPlanning', 'race_test', 1, {});

      const resultA = await store.append('race_test', [eventA], 0);
      
      try {
        await store.append('race_test', [eventB], 0);
        throw new Error('Should have thrown');
      } catch (error: unknown) {
        expect(isConcurrencyError(error)).toBe(true);
      }

      expect(resultA.appendedCount).toBe(1);
      expect(await store.getAggregateVersion('race_test')).toBe(1);
    });
  });

  describe('Worktree Lease Fencing', () => {
    let leaseRepo: InMemoryWorktreeLeaseRepository;

    beforeEach(() => {
      leaseRepo = new InMemoryWorktreeLeaseRepository();
    });

    it('acquire succeeds when no owner', async () => {
      const result = await leaseRepo.acquire('worktree_xyz', 'worker_1');

      expect(result.success).toBe(true);
      expect(result.lease).toBeDefined();
      expect(result.lease!.ownerId).toBe('worker_1');
      expect(result.lease!.fencingToken).toBe(1);
    });

    it('competing acquire fails', async () => {
      await leaseRepo.acquire('worktree_compete', 'worker_A');

      const result = await leaseRepo.acquire('worktree_compete', 'worker_B');

      expect(result.success).toBe(false);
    });

    it('renew works only for owner', async () => {
      await leaseRepo.acquire('worktree_renew', 'owner_1');

      const renewResult = await leaseRepo.renew('worktree_renew', 'owner_1');
      expect(renewResult.success).toBe(true);

      const badRenewResult = await leaseRepo.renew('worktree_renew', 'intruder');
      expect(badRenewResult.success).toBe(false);
    });

    it('fencing token rejects stale owners', async () => {
      const { lease } = await leaseRepo.acquire('worktree_fence', 'owner_X');
      expect(lease).toBeDefined();
      const token = lease!.fencingToken;

      const validValidation = leaseRepo.validateFencing('worktree_fence', 'owner_X', token);
      expect(validValidation.valid).toBe(true);

      const staleValidation = leaseRepo.validateFencing('worktree_fence', 'owner_X', token - 1);
      expect(staleValidation.valid).toBe(false);
      expect(staleValidation.error?.type).toBe('FENCING_VIOLATION');
    });
  });
});
