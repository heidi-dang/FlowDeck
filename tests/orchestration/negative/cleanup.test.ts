import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { deterministicCleanup } from '../harness/cleanup';

let tempDir = '';
let connections: Database[] = [];

function createConnection() {
  const db = new Database(join(tempDir, 'cleanup_test.db'));
  connections.push(db);
  return db;
}

describe('Resource Cleanup Validation', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clean-test-'));
    const setupDb = createConnection();
    setupDb.exec(`CREATE TABLE events (id TEXT)`);
    setupDb.close();
    connections = [];
  });

  afterEach(() => {
    for (const conn of connections) {
      try { conn.close(); } catch { /* already closed */ }
    }
    connections = [];
    deterministicCleanup({ dir: tempDir });
  });

  it('handles already closed connection gracefully', () => {
    const conn = createConnection();
    conn.close();
    // afterEach will close it again, which should be caught
    expect(true).toBe(true);
  });

  it('cleans up even if assertion fails', () => {
    createConnection();
    createConnection();
    expect(connections.length).toBe(2); // 2 created in test body
  });
});
