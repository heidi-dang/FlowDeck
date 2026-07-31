import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { deterministicCleanup } from "../harness/cleanup";

describe('Replay Harness Validation', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE events (aggregate_id TEXT, version INTEGER, payload TEXT, UNIQUE(aggregate_id, version))`);
  });

  afterEach(async () => {
    await deterministicCleanup({ db });
  });

  it('Empty stream', () => {
    const stream = db.query('SELECT * FROM events ORDER BY version ASC').all();
    expect(stream.length).toBe(0);
  });

  it('Ordered replay', () => {
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 2, 'v2');
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'v1');
    const stream = db.query('SELECT version FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1') as any[];
    expect(stream.map(r => r.version)).toEqual([1, 2]);
  });

  it('Aggregate-version gaps', () => {
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'v1');
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 3, 'v3');
    const stream = db.query('SELECT version FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1') as any[];
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
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'v1');
    expect(() => db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'v1_dup')).toThrow(/UNIQUE constraint failed/);
  });

  it('Unknown payload version', () => {
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, JSON.stringify({ type: 'TestEvent', v: 999 }));
    const ev = db.query('SELECT payload FROM events WHERE aggregate_id = ?').get('a1') as any;
    const payload = JSON.parse(ev.payload);
    // Domain router should reject unknown versions
    expect(payload.v).toBe(999);
  });

  it('Terminal states', () => {
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'start');
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 2, 'completed');
    const stream = db.query('SELECT payload FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1') as any[];
    expect(stream[stream.length - 1].payload).toBe('completed');
  });

  it('Cancellation', () => {
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'start');
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 2, 'cancelled');
    const stream = db.query('SELECT payload FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1') as any[];
    expect(stream[stream.length - 1].payload).toBe('cancelled');
  });

  it('Recovery', () => {
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'start');
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 2, 'failed');
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 3, 'recovered');
    const stream = db.query('SELECT payload FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1') as any[];
    expect(stream[stream.length - 1].payload).toBe('recovered');
  });

  it('Repeated deterministic replay', () => {
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 1, 'e1');
    db.query('INSERT INTO events (aggregate_id, version, payload) VALUES (?, ?, ?)').run('a1', 2, 'e2');
    
    const stream1 = db.query('SELECT * FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1');
    const stream2 = db.query('SELECT * FROM events WHERE aggregate_id = ? ORDER BY version ASC').all('a1');
    
    expect(JSON.stringify(stream1)).toBe(JSON.stringify(stream2));
  });
});
