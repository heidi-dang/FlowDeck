import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export class SqliteTestHarness {
  public db: Database;
  constructor(memory: boolean = true) {
    const dbPath = memory ? ':memory:' : join(mkdtempSync(join(tmpdir(), 'harness-')), 'test.db');
    this.db = new Database(dbPath);
  }
  execute(query: string, params: unknown[] = []): void {
    const stmt = this.db.prepare(query);
    stmt.run(...params as SQLQueryBindings[]);
  }
  execScript(script: string): void {
    this.db.run(script);
  }
  query<T = unknown>(sql: string, bindings: unknown[] = []): T[] {
    return this.db.query(sql).all(...(bindings as SQLQueryBindings[])) as T[];
  }

  async run(sql: string, bindings: unknown[] = []): Promise<void> {
    this.db.query(sql).run(...(bindings as SQLQueryBindings[]));
  }
  close(): void {
    this.db.close();
  }
}
