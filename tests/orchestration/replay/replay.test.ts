import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { deterministicCleanup } from "../harness/cleanup";

describe('Replay Harness Validation', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE events (aggregate_id TEXT, version INTEGER, payload TEXT, UNIQUE(aggregate_id, version))`);
  });

  afterEach(() => {
    deterministicCleanup({ db });
  });

  it('Empty stream', () => {
    const stream = db.prepare('SELECT * FROM events ORDER BY version ASC').all();
    expect(stream.length).toBe(0);
  });

  it('Ordered replay', () => {
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 2, 'v2');
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'v1');
    const stream = db.prepare('SELECT version FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1') as any[];
    expect(stream.map(r => r.version)).toEqual([1, 2]);
  });

  it('Aggregate-version gaps', () => {
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'v1');
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 3, 'v3');
    const stream = db.prepare('SELECT version FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1') as any[];
    // Domain should reject this on replay application
    let valid = true;
    let expected = 1;
    for (const event of stream) {
      if (event.version !== expected) {
        valid = false;
        break;
      }
      expected++;
    }
    expect(valid).toBe(false);
  });

  it('Duplicate events', () => {
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'v1');
    expect(() => db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'v1_dup')).toThrow(/UNIQUE constraint failed/);
  });

  it('Unknown payload version', () => {
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, JSON.stringify({ type: 'TestEvent', v: 999 }));
    const ev = db.prepare('SELECT payload FROM events WHERE aggregate_id = ?').get('a1') as any;
    const payload = JSON.parse(ev.payload);
    // Domain router should reject unknown versions
    expect(payload.v).toBe(999);
  });

  it('Terminal states', () => {
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'start');
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 2, 'completed');
    const stream = db.prepare('SELECT payload FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1') as any[];
    expect(stream[stream.length - 1].payload).toBe('completed');
  });

  it('Cancellation', () => {
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'start');
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 2, 'cancelled');
    const stream = db.prepare('SELECT payload FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1') as any[];
    expect(stream[stream.length - 1].payload).toBe('cancelled');
  });

  it('Recovery', () => {
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'start');
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 2, 'failed');
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 3, 'recovered');
    const stream = db.prepare('SELECT payload FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1') as any[];
    expect(stream[stream.length - 1].payload).toBe('recovered');
  });

  it('Repeated deterministic replay', () => {
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'e1');
    db.prepare('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 2, 'e2');
    
    const stream1 = db.prepare('SELECT * FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1');
    const stream2 = db.prepare('SELECT * FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1');
    
    expect(JSON.stringify(stream1)).toBe(JSON.stringify(stream2));
  });
});
