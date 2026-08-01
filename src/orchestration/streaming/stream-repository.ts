import { Database } from 'bun:sqlite';

export class StreamRepository {
  private db: Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        UNIQUE(run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS event_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        delivered INTEGER DEFAULT 0
      );
    `);
  }

  persistEvent(runId: string, sequence: number, type: string, data: any, timestamp: number): number {
    const stmt = this.db.prepare('INSERT INTO events (run_id, sequence, type, data, timestamp) VALUES (?, ?, ?, ?, ?)');
    stmt.run(runId, sequence, type, JSON.stringify(data), timestamp);
    const lastId = this.db.query('SELECT last_insert_rowid() as id').get() as { id: number };
    
    const outboxStmt = this.db.prepare('INSERT INTO event_outbox (event_id) VALUES (?)');
    outboxStmt.run(lastId.id);
    
    return lastId.id;
  }

  getEventsAfter(runId: string, afterSequence: number): any[] {
    const stmt = this.db.prepare('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC');
    const rows = stmt.all(runId, afterSequence) as any[];
    return rows.map(row => ({
      ...row,
      data: JSON.parse(row.data)
    }));
  }

  markDelivered(eventId: number) {
    const stmt = this.db.prepare('UPDATE event_outbox SET delivered = 1 WHERE event_id = ?');
    stmt.run(eventId);
  }

  getDb(): Database {
    return this.db;
  }
}
