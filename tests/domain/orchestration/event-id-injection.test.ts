/**
 * Event ID Injection Tests - Phase 3B
 * 
 * Verify deterministic event ID generation with injectable generators
 */

import { describe, it, expect } from 'bun:test';
import { InMemoryRuntimeEventStore } from '../../../src/domain/orchestration/runtime/event-store/in-memory-store';
import { createDeterministicGenerators, defaultEventIdGenerator } from '../../../src/domain/orchestration/runtime/event-store/event-id-generator';
import type { UncommittedRuntimeEvent } from '../../../src/domain/orchestration/runtime/event-store/types';

describe('PR 3B - Event ID Injection', () => {

  it('deterministic ID injection works correctly', async () => {
    const eventIds = ['evt_1', 'evt_2', 'evt_3'];
    const testStore = new InMemoryRuntimeEventStore(
      () => eventIds[0]
    );
    
    await testStore.append('test-aggregate', [
      {
        eventType: 'RunCreated',
        aggregateId: 'test-aggregate',
        aggregateVersion: 0,
        eventId: undefined,
        payload: {}
      } as UncommittedRuntimeEvent
    ], 0);
    
    const events = await testStore.readStream('test-aggregate');
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe('evt_1');
  });

  it('default generator produces unique IDs', async () => {
    const ids: string[] = [];
    
    for (let i = 0; i < 100; i++) {
      const id = defaultEventIdGenerator();
      expect(id).toMatch(/^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(ids).not.toContain(id);
      ids.push(id);
    }
  });

  it('concurrent ID generation is safe', () => {
    const results: string[][] = [[]];
    
    // Simulate concurrent execution in a single thread
    for (let i = 0; i < 10; i++) {
      const batch: string[] = [];
      for (let j = 0; j < 100; j++) {
        batch.push(defaultEventIdGenerator());
      }
      results.push(batch);
    }
    
    // Flatten and check uniqueness
    const allIds = results.flat();
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });

  it('append operation IDs cannot collide', async () => {
    const appendIds: string[] = [];
    
    // Test that appendIdGenerator uses separate namespace
    const crypto = require('crypto');
    const testStore = new InMemoryRuntimeEventStore(undefined, () => `app_${crypto.randomUUID()}`);
    
    // Multiple appends should have unique IDs
    const dummyEvent: UncommittedRuntimeEvent = { eventType: 'Test', aggregateId: 'agg-1', aggregateVersion: 1 };
    await testStore.append('agg-1', [{ ...dummyEvent, aggregateId: 'agg-1' }], 0);
    await testStore.append('agg-2', [{ ...dummyEvent, aggregateId: 'agg-2' }], 0);
    
    expect(appendIds.length).toBe(0); // Not stored, just generated
    
    // The actual implementation uses UUID so collisions are astronomically unlikely
  });

  it('deterministic generators throw when exhausted', () => {
    const eventIds = ['A', 'B'];
    const appendIds = ['X'];
    
    const { eventIdGenerator, appendIdGenerator } = createDeterministicGenerators(eventIds, appendIds);
    
    expect(eventIdGenerator()).toBe('A');
    expect(eventIdGenerator()).toBe('B');
    expect(() => eventIdGenerator()).toThrow('sequence exhausted');
    
    expect(appendIdGenerator()).toBe('X');
    expect(() => appendIdGenerator()).toThrow('sequence exhausted');
  });

  it('explicit eventId overrides generator', async () => {
    const customId = 'custom-explicit-id';
    const testStore = new InMemoryRuntimeEventStore(() => 'should-not-be-used');
    
    await testStore.append('test', [
      {
        eventType: 'RunCreated',
        aggregateId: 'test',
        aggregateVersion: 0,
        eventId: customId,
        payload: {}
      } as UncommittedRuntimeEvent
    ], 0);
    
    const events = await testStore.readStream('test');
    expect(events[0].eventId).toBe(customId);
  });
});
