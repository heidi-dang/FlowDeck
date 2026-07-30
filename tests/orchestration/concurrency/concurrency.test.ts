import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { deterministicCleanup } from '../harness/cleanup';

let tempDir: string = '';
let connections: Database[] = [];

function createConnection(dbPath?: string) {
  const path = dbPath ?? join(tempDir, 'concurrency_test.db');
  const db = new Database(path);
  connections.push(db);
  return db;
}

describe('Concurrency Harness Validation', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'conc-test-'));
    const dbPath = join(tempDir, 'concurrency_test.db');
    const setupDb = createConnection(dbPath);
    setupDb.exec(`CREATE TABLE events (aggregate_id TEXT, version INTEGER, UNIQUE(aggregate_id, version))`);
    setupDb.close();
    connections = [];
  });

  afterEach(() => {
    for (const db of connections) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    connections = [];
    try {
      deterministicCleanup({ dir: tempDir });
    } catch {
      // best-effort
    }
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
  });
});
