import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import Database from 'better-sqlite3';
import { unlinkSync, existsSync } from 'fs';
import { SCHEMA_V_0_2_6 } from '../../../src/orchestration/persistence/migrations/schema-embed';
import { createTransactionManager } from '../../../src/orchestration/persistence/transaction-manager';
import { EventsRepository } from '../../../src/orchestration/persistence/repositories/event';
import { TaskRunsRepository } from '../../../src/orchestration/persistence/repositories/task-run';

const DB_PATH = 'concurrency_test.db';

function createConnection() {
  return new Database(DB_PATH);
}

// Barrier for coordinating concurrent execution steps
class Barrier {
  private promise: Promise<void>;
  private resolveFn!: () => void;
  
  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolveFn = resolve;
    });
  }
  
  wait() {
    return this.promise;
  }
  
  release() {
    this.resolveFn();
  }
}

describe('Concurrency Validation', () => {
  beforeEach(() => {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
    const setupDb = createConnection();
    setupDb.exec(SCHEMA_V_0_2_6);
    setupDb.close();
  });

  afterEach(() => {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  });

  it('handles two event appends using the same aggregate version (EventStore)', async () => {
    const conn1 = createConnection();
    const conn2 = createConnection();
    const tx1 = createTransactionManager(conn1);
    const tx2 = createTransactionManager(conn2);
    const repo1 = new EventsRepository(conn1, tx1);
    const repo2 = new EventsRepository(conn2, tx2);

    const barrier1 = new Barrier();
    const barrier2 = new Barrier();

    const aggregateId = 'agg-1';

    const p1 = (async () => {
      try {
        await repo1.appendEvent(aggregateId, { type: 'T1' }, 0);
        return 'success';
      } catch (e: any) {
        return e.message;
      }
    })();

    const p2 = (async () => {
      try {
        await repo2.appendEvent(aggregateId, { type: 'T2' }, 0);
        return 'success';
      } catch (e: any) {
        return e.code || e.message;
      }
    })();

    const results = await Promise.all([p1, p2]);
    
    // One should succeed, one should fail due to unique constraint on (aggregate_id, aggregate_version)
    const successes = results.filter(r => r === 'success').length;
    const failures = results.filter(r => r !== 'success').length;
    
    expect(successes).toBe(1);
    expect(failures).toBe(1);

    // Assert final row count
    const conn3 = createConnection();
    const count = conn3.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number };
    expect(count.c).toBe(1);

    conn1.close();
    conn2.close();
    conn3.close();
  });

  it('handles two task-run updates with optimistic version conflict', async () => {
    const conn1 = createConnection();
    const conn2 = createConnection();
    
    const repoSetup = new TaskRunsRepository(conn1, createTransactionManager(conn1));
    const run = repoSetup.create({ runId: 'r1', contractId: 'c1', strategy: 'simple', baselineSha: 'sha', repoBranch: 'main' });
    
    const repo1 = new TaskRunsRepository(conn1, createTransactionManager(conn1));
    const repo2 = new TaskRunsRepository(conn2, createTransactionManager(conn2));

    const p1 = (async () => {
      try {
        return await repo1.updateState('r1', 'created', 'planned');
      } catch (e: any) {
        return e.message;
      }
    })();

    const p2 = (async () => {
      try {
        // Assume both read 'created' as expected state
        return await repo2.updateState('r1', 'created', 'executing');
      } catch (e: any) {
        return e.message;
      }
    })();

    const results = await Promise.all([p1, p2]);

    const successes = results.filter(r => r === true).length;
    // Expected: 1 success, 1 failure (update returns false or throws)
    // The implementation might return false or throw. Assuming it returns false based on Dev 3 rules.
    const failures = results.filter(r => r === false || typeof r === 'string').length;

    expect(successes).toBe(1);
    expect(failures).toBe(1);

    conn1.close();
    conn2.close();
  });
});
