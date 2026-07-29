import { Database, type SQLQueryBindings } from 'bun:sqlite';

export class SqliteTestHarness {
  public db: Database;
  constructor(memory: boolean = true) {
    this.db = new Database(memory ? ':memory:' : 'test.db');
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
