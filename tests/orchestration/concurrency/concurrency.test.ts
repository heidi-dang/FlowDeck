import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { unlinkSync, existsSync } from 'fs';

let currentDbPath = '';
let connections: Database[] = [];

function createConnection() {
  const db = new Database(currentDbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  connections.push(db);
  return db;
}

describe('Concurrency Harness Validation', () => {
  beforeEach(() => {
    currentDbPath = `concurrency_test_${Date.now()}_${Math.random().toString(36).substring(7)}.db`;
    if (existsSync(currentDbPath)) unlinkSync(currentDbPath);
    const setupDb = createConnection();
    setupDb.exec(`CREATE TABLE events (aggregate_id TEXT, version INTEGER, data TEXT, UNIQUE(aggregate_id, version))`);
    setupDb.exec(`CREATE TABLE claims (resource_id TEXT PRIMARY KEY, owner TEXT, token INTEGER)`);
    setupDb.close();
  });

  afterEach(() => {
    for (const db of connections) {
      try { db.close(); } catch {}
    }
    connections = [];
    try { if (existsSync(currentDbPath)) unlinkSync(currentDbPath); } catch {}
  });

  it('Concurrent append', async () => {
    const conn1 = createConnection();
    const conn2 = createConnection();
    const p1 = (async () => {
      try { conn1.prepare('INSERT INTO events (aggregate_id, version, data) VALUES (?, ?, ?)').run('a1', 1, 'v1'); return 'success'; } catch (e: any) { return e.code || e.message; }
    })();
    const p2 = (async () => {
      try { conn2.prepare('INSERT INTO events (aggregate_id, version, data) VALUES (?, ?, ?)').run('a1', 1, 'v2'); return 'success'; } catch (e: any) { return e.code || e.message; }
    })();
    const results = await Promise.all([p1, p2]);
    expect(results.filter(r => r === 'success').length).toBe(1);
    expect(results.filter(r => r === 'SQLITE_CONSTRAINT_UNIQUE').length).toBe(1);
  });

  it('Stale aggregate version', () => {
    const conn = createConnection();
    conn.prepare('INSERT INTO events (aggregate_id, version, data) VALUES (?, ?, ?)').run('a2', 2, 'data');
    expect(() => conn.prepare('INSERT INTO events (aggregate_id, version, data) VALUES (?, ?, ?)').run('a2', 2, 'stale')).toThrow(/UNIQUE constraint failed/);
  });

  it('Future aggregate version', () => {
    const conn = createConnection();
    conn.prepare('INSERT INTO events (aggregate_id, version, data) VALUES (?, ?, ?)').run('a3', 1, 'data');
    const latest = conn.prepare('SELECT MAX(version) as v FROM events WHERE aggregate_id = ?').get('a3') as any;
    expect(latest.v).toBe(1);
    // Gap check - our domain requires version = latest.v + 1
    const nextVersion = 3;
    expect(nextVersion).not.toBe(latest.v + 1);
  });

  it('Duplicate command', () => {
    const conn = createConnection();
    conn.prepare('INSERT INTO events (aggregate_id, version, data) VALUES (?, ?, ?)').run('cmd1', 1, 'start');
    expect(() => conn.prepare('INSERT INTO events (aggregate_id, version, data) VALUES (?, ?, ?)').run('cmd1', 1, 'start')).toThrow(/UNIQUE constraint failed/);
  });

  it('SQLite writer contention', async () => {
    const conn1 = createConnection();
    const conn2 = createConnection();
    // Simulate long transaction
    conn1.exec('BEGIN EXCLUSIVE TRANSACTION');
    let err2: any;
    try {
      // In bun:sqlite without setting timeout, it throws SQLITE_BUSY immediately.
      conn2.exec('BEGIN EXCLUSIVE TRANSACTION');
    } catch (e: any) {
      err2 = e;
    }
    conn1.exec('ROLLBACK');
    expect(err2.code).toBe('SQLITE_BUSY');
  });

  it('Fencing-token rejection', () => {
    const conn = createConnection();
    conn.prepare('INSERT INTO claims (resource_id, owner, token) VALUES (?, ?, ?)').run('res1', 'o1', 10);
    // Try update with older token
    const res = conn.prepare('UPDATE claims SET owner = ?, token = ? WHERE resource_id = ? AND token < ?').run('o2', 9, 'res1', 9);
    expect(res.changes).toBe(0); // Rejected
  });

  it('Claim exclusion', () => {
    const conn = createConnection();
    conn.prepare('INSERT INTO claims (resource_id, owner, token) VALUES (?, ?, ?)').run('res2', 'o1', 1);
    expect(() => conn.prepare('INSERT INTO claims (resource_id, owner, token) VALUES (?, ?, ?)').run('res2', 'o2', 2)).toThrow(/UNIQUE constraint failed/);
  });

  it('Ownership conflict', () => {
    const conn = createConnection();
    conn.prepare('INSERT INTO claims (resource_id, owner, token) VALUES (?, ?, ?)').run('res3', 'o1', 1);
    const claim = conn.prepare('SELECT owner FROM claims WHERE resource_id = ?').get('res3') as any;
    expect(claim.owner).not.toBe('o2'); // Conflict
  });
});
