import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteTestHarness } from '../harness/sqlite-harness';
import { SCHEMA_V_0_2_6 } from '../../../src/orchestration/persistence/migrations/schema-embed';

describe('Architecture Compliance Tests', () => {
  let harness: SqliteTestHarness;

  beforeEach(() => {
    harness = new SqliteTestHarness();
    harness.execScript(SCHEMA_V_0_2_6);
  });

  afterEach(() => {
    harness.close();
  });

  it('validates schema object counts (53 tables, 36 triggers, 66 indexes)', () => {
    const tables = harness.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';");
    const triggers = harness.query("SELECT name FROM sqlite_master WHERE type='trigger';");
    const indexes = harness.query("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%';");
    
    console.log(`Counts: tables=${tables.length}, triggers=${triggers.length}, indexes=${indexes.length}`);
    // Validate exact counts
    expect(tables.length).toBe(53);
    expect(triggers.length).toBe(36);
    expect(indexes.length).toBe(66);
  });

  it('validates explicit semantic constraints and core tables', () => {
    const coreTables = ['events', 'event_outbox', 'task_runs', 'contract_families', 'verification_results', 'evidence'];
    const tables = harness.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';") as {name: string}[];
    const tableNames = tables.map(t => t.name);
    
    console.log('Tables:', tableNames);
    
    for (const table of coreTables) {
      expect(tableNames).toContain(table);
    }
  });
  
  it('validates integrity check', () => {
    const integrity = harness.query('PRAGMA integrity_check;') as {integrity_check: string}[];
    expect(integrity[0].integrity_check).toBe('ok');
  });
});
