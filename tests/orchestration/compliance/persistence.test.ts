import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteTestHarness } from '../harness/sqlite-harness';
import { TransactionHarness } from '../harness/transaction-harness';

describe('Persistence Compliance Suite', () => {
  let harness: SqliteTestHarness;
  let txHarness: TransactionHarness;

  beforeEach(() => {
    harness = new SqliteTestHarness();
    harness.execute('CREATE TABLE persistence_test (id TEXT PRIMARY KEY, val TEXT);');
    txHarness = new TransactionHarness(harness);
  });

  afterEach(() => {
    harness.close();
  });

  it('validates transaction rollback', async () => {
    try {
      await txHarness.runInTransaction(async () => {
        harness.execute("INSERT INTO persistence_test (id, val) VALUES ('1', 'test')");
        throw new Error('rollback');
      });
    } catch {
      // expected
    }
    const rows = harness.query("SELECT * FROM persistence_test");
    expect(rows.length).toBe(0);
  });
});
