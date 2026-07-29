import { describe, it, expect } from 'bun:test';
import { runContractSuite } from './compliance-reporter';

export interface ExpectedEventStore {
  appendEvent(aggregateId: string, event: unknown, expectedVersion: number): Promise<void>;
  getEvents(aggregateId: string): Promise<unknown[]>;
  getAllEvents(afterSequence?: number): Promise<unknown[]>;
}

export function runEventStoreContract(
  factory: () => ExpectedEventStore,
  implementationName: string = 'Unknown',
  sha: string = 'HEAD'
) {
  describe(`EventStore Compliance (${implementationName})`, () => {
    it('validates against Dev 1 exact port methods and semantics', async () => {
      const result = await runContractSuite<ExpectedEventStore>(
        'EventStore',
        implementationName,
        sha,
        'v0.2.6',
        factory,
        ['appendEvent', 'getEvents', 'getAllEvents'],
        async (repo, recordFailure) => {
          try {
            await repo.appendEvent('agg-1', { type: 'test' }, 0);
            const evs = await repo.getEvents('agg-1');
            if (evs.length !== 1) recordFailure('appendEvent/getEvents failed');
            
            const all = await repo.getAllEvents(0);
            if (all.length === 0) recordFailure('getAllEvents failed');
          } catch (e: any) {
            recordFailure(e.message);
          }
        }
      );
      expect(result.port).toBe('EventStore');
    });
  });
}
