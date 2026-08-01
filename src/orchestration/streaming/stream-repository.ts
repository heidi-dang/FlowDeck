import { Database } from 'bun:sqlite';
import { initializeDatabase, createTransactionManager, type TransactionManager } from '../persistence';
import { EventsRepository } from '../persistence/repositories/event';
import type { FlowDeckStreamEvent } from './stream-event';

export interface StreamRepositoryOptions {
  allowInMemory?: boolean;
}

export class StreamRepository {
  private db: Database;
  private txManager: TransactionManager;
  private eventsRepo: EventsRepository;

  constructor(dbPathOrDb?: string | Database, options?: StreamRepositoryOptions) {
    if (typeof dbPathOrDb === 'object' && dbPathOrDb !== null) {
      this.db = dbPathOrDb;
    } else {
      let path = dbPathOrDb || process.env.FLOWDECK_DB_PATH || './flowdeck.db';
      if (path === ':memory:') {
        const isTest = process.env.NODE_ENV === 'test' || options?.allowInMemory === true;
        if (!isTest) {
          throw new Error('Production database cannot default to :memory:. Specify a valid database file path.');
        }
      }
      const res = initializeDatabase({ path });
      this.db = res.db;
    }

    this.txManager = createTransactionManager(this.db);
    this.eventsRepo = new EventsRepository(this.db, this.txManager);
  }

  /**
   * Persist a stream event with sequence allocation and outbox creation in one single atomic transaction.
   * Rejects duplicate event IDs with conflict errors and checks affected row counts.
   */
  persistEvent(runId: string, sequence: number, type: string, data: any, timestamp: number): number {
    return this.txManager.write(() => {
      const eventId = (data && data.eventId) ? data.eventId : `evt_${runId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // 1. Check for duplicate eventId (idempotency check)
      const existing = this.db.query(`
        SELECT aggregate_version, data FROM events WHERE event_id = ?
      `).get(eventId) as { aggregate_version: number; data: string } | null;

      if (existing) {
        let existingData: any = {};
        try { existingData = JSON.parse(existing.data); } catch { /* ignore */ }

        // If exact same run & payload, idempotently return existing sequence
        const incomingPayload = typeof data === 'object' ? JSON.stringify(data) : String(data);
        if (existingData.runId === runId || incomingPayload === existing.data) {
          return existing.aggregate_version;
        }
        throw new Error(`Conflict: Event ID '${eventId}' already exists with different payload.`);
      }

      // 2. Monotonic sequence allocation
      const currentMax = this.eventsRepo.getMaxAggregateVersion('run', runId);
      let finalSeq = (sequence && sequence > currentMax) ? sequence : currentMax + 1;

      // Ensure full canonical event representation is preserved in `data` column
      const eventObj = typeof data === 'object' ? { ...data, sequence: finalSeq, runId, eventId } : { payload: data, sequence: finalSeq, runId, eventId };
      const isoTimestamp = new Date(timestamp || Date.now()).toISOString();
      const payloadString = JSON.stringify(eventObj);

      // 3. Strict INSERT into `events` table (checking affected rows)
      const eventInsertStmt = this.db.prepare(`
        INSERT INTO events (
          event_id, event_type, event_version, causation_id, correlation_id,
          aggregate_type, aggregate_id, aggregate_version, timestamp, data, metadata, created_ts
        ) VALUES (
          ?, ?, 1, NULL, NULL,
          'run', ?, ?, ?, ?, '{}', strftime('%s','now')
        )
      `);

      const eventResult = eventInsertStmt.run(eventId, type, runId, finalSeq, isoTimestamp, payloadString);
      if (eventResult.changes === 0) {
        throw new Error(`Failed to insert event ${eventId}: 0 rows affected.`);
      }

      // 4. Strict INSERT into `event_outbox` table in the SAME atomic transaction
      const outboxId = `outbox_${eventId}_${Date.now()}`;
      const idempotencyKey = `outbox_key_${runId}_${finalSeq}_${eventId}`;

      const outboxInsertStmt = this.db.prepare(`
        INSERT INTO event_outbox (
          id, event_id, event_type, aggregate_id, data, status, idempotency_key, source_component, created_ts
        ) VALUES (
          ?, ?, ?, ?, ?, 'pending', ?, 'streaming', strftime('%s','now')
        )
      `);

      const outboxResult = outboxInsertStmt.run(outboxId, eventId, type, runId, payloadString, idempotencyKey);
      if (outboxResult.changes === 0) {
        throw new Error(`Failed to insert outbox record for event ${eventId}: 0 rows affected.`);
      }

      return finalSeq;
    });
  }

  /**
   * Fetch historical events for a run aggregate after a specific sequence.
   * Returns fully typed canonical `FlowDeckStreamEvent` objects without fabricated fields.
   */
  getEventsAfter(runId: string, afterSequence: number): FlowDeckStreamEvent[] {
    const rows = this.db.query(`
      SELECT data FROM events
      WHERE aggregate_type = 'run' AND aggregate_id = ? AND aggregate_version > ?
      ORDER BY aggregate_version ASC
    `).all(runId, afterSequence) as Array<{ data: string }>;

    return rows.map(r => JSON.parse(r.data) as FlowDeckStreamEvent);
  }

  /**
   * Fetch historical events within a specific sequence range (afterExclusive, throughInclusive].
   */
  getEventsInRange(runId: string, afterExclusive: number, throughInclusive: number): FlowDeckStreamEvent[] {
    const rows = this.db.query(`
      SELECT data FROM events
      WHERE aggregate_type = 'run' AND aggregate_id = ? AND aggregate_version > ? AND aggregate_version <= ?
      ORDER BY aggregate_version ASC
    `).all(runId, afterExclusive, throughInclusive) as Array<{ data: string }>;

    return rows.map(r => JSON.parse(r.data) as FlowDeckStreamEvent);
  }

  /**
   * Get current maximum committed sequence for a run aggregate.
   */
  getHighWatermark(runId: string): number {
    return this.eventsRepo.getMaxAggregateVersion('run', runId);
  }

  /**
   * Mark an outbox item as delivered.
   */
  markDelivered(eventId: string) {
    this.txManager.write(() => {
      this.db.query(`
        UPDATE event_outbox
        SET status = 'delivered', delivered_ts = strftime('%s','now')
        WHERE event_id = ?
      `).run(eventId);
    });
  }

  getDb(): Database {
    return this.db;
  }
}
