import { Database } from 'bun:sqlite';

export class SqliteTestHarness {
  public db: Database;
  constructor(memory: boolean = true) {
    this.db = new Database(memory ? ':memory:' : 'test.db');
  }
  execute(query: string, params: unknown[] = []): void {
    const stmt = this.db.prepare(query);
    stmt.run(...params);
  }
  execScript(script: string): void {
    this.db.run(script);
  }
  query<T = unknown>(query: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(query);
    return stmt.all(...params) as T[];
  }
  close(): void {
    this.db.close();
  }
}
