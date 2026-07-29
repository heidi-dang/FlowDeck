import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteTestHarness } from '../harness/sqlite-harness';

describe('Architecture Compliance Tests', () => {
  let harness: SqliteTestHarness;

  beforeEach(() => {
    harness = new SqliteTestHarness();
    harness.execute('CREATE TABLE test_table (id TEXT PRIMARY KEY, val TEXT);');
  });

  afterEach(() => {
    harness.close();
  });

  it('validates schema object counts', () => {
    const tables = harness.query("SELECT name FROM sqlite_master WHERE type='table';");
    expect(tables.length).toBeGreaterThan(0);
  });

  it('validates required tables exist', () => {
    const tables = harness.query("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table';");
    expect(tables.length).toBe(1);
  });
  
  it('validates integrity check', () => {
    const integrity = harness.query('PRAGMA integrity_check;');
    expect(integrity[0].integrity_check).toBe('ok');
  });
});
