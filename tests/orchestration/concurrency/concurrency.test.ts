import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import Database from 'better-sqlite3';
import { unlinkSync, existsSync } from 'fs';

const DB_PATH = 'concurrency_test.db';

function createConnection() {
  return new Database(DB_PATH);
}

// Barrier for coordinating concurrent execution steps in our test harness
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

describe('Concurrency Harness Validation', () => {
  beforeEach(() => {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
    const setupDb = createConnection();
    setupDb.exec(`CREATE TABLE events (aggregate_id TEXT, version INTEGER, UNIQUE(aggregate_id, version))`);
    setupDb.close();
  });

  afterEach(() => {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  });

  it('validates the test harness barrier mechanisms on concurrent DB inserts', async () => {
    const conn1 = createConnection();
    const conn2 = createConnection();

    const p1 = (async () => {
      try {
        conn1.prepare('INSERT INTO events (aggregate_id, version) VALUES (?, ?)').run('a1', 1);
        return 'success';
      } catch (e: any) {
        return e.message;
      }
    })();

    const p2 = (async () => {
      try {
        conn2.prepare('INSERT INTO events (aggregate_id, version) VALUES (?, ?)').run('a1', 1);
        return 'success';
      } catch (e: any) {
        return e.code || e.message;
      }
    })();

    const results = await Promise.all([p1, p2]);
    
    const successes = results.filter(r => r === 'success').length;
    const failures = results.filter(r => r !== 'success').length;
    
    expect(successes).toBe(1);
    expect(failures).toBe(1);

    conn1.close();
    conn2.close();
  });
});
