import { Database } from 'bun:sqlite';

export class SqliteTestHarness {
  public db: Database;
  constructor(memory: boolean = true) {
    this.db = new Database(memory ? ':memory:' : 'test.db');
  }
  execute(query: string, params: any[] = []): void {
    const stmt = this.db.prepare(query);
    stmt.run(...params);
  }
  query(query: string, params: any[] = []): any[] {
    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }
  close(): void {
    this.db.close();
  }
}
