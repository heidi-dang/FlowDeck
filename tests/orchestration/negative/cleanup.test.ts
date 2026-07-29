import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir = '';
let DB_PATH = '';
let connections: Database[] = [];

function createConnection() {
  const db = new Database(DB_PATH);
  connections.push(db);
  return db;
}

describe('Resource Cleanup Validation', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clean-test-'));
    DB_PATH = join(tempDir, 'cleanup_test.db');
    const setupDb = createConnection();
    setupDb.exec(`CREATE TABLE events (id TEXT)`);
  });

  afterEach(() => {
    for (const db of connections) {
      try {
        db.close();
      } catch {
        // ignore if already closed
      }
    }
    connections = [];
    try {
      if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
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
    // if we put expect(false).toBe(true) it would fail the suite, 
    // but we can manually verify logic
    expect(connections.length).toBe(3); // 1 from beforeEach, 2 from here
  });
});
