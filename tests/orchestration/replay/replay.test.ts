import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';

describe('Replay Harness Validation', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE events (event_id TEXT PRIMARY KEY, version INTEGER, data TEXT)`);
  });

  afterEach(() => {
    db.close();
  });

  it('validates test harness replay capability on a raw stream', () => {
    db.prepare('INSERT INTO events (event_id, version, data) VALUES (?, ?, ?)').run('1', 1, '{"a":1}');
    db.prepare('INSERT INTO events (event_id, version, data) VALUES (?, ?, ?)').run('2', 2, '{"b":2}');
    
    const events = db.prepare('SELECT * FROM events ORDER BY version ASC').all() as any[];
    expect(events.length).toBe(2);
    
    // Simulating replay locally
    const projection = events.reduce((acc, ev) => ({ ...acc, ...JSON.parse(ev.data) }), {});
    expect(JSON.stringify(projection)).toBe('{"a":1,"b":2}');
  });

  it('verifies constraint on duplicate delivery', () => {
    db.prepare('INSERT INTO events (event_id, version, data) VALUES (?, ?, ?)').run('1', 1, '{"a":1}');
    expect(() => {
      db.prepare('INSERT INTO events (event_id, version, data) VALUES (?, ?, ?)').run('1', 1, '{"a":1}');
    }).toThrow(/UNIQUE constraint failed/);
  });
});
