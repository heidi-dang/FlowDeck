import { Database } from 'bun:sqlite';
import { initializeDatabase, createTransactionManager, type TransactionManager } from '../persistence';
import { EventsRepository } from '../persistence/repositories/event';

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
   */
  persistEvent(runId: string, sequence: number, type: string, data: any, timestamp: number): number {
    return this.txManager.write(() => {
      // 1. Determine atomic sequence for this run aggregate
      const currentMax = this.eventsRepo.getMaxAggregateVersion('run', runId);
      let finalSeq = (sequence && sequence > currentMax) ? sequence : currentMax + 1;

      const eventId = (data && data.eventId) ? data.eventId : `evt_${runId}_${finalSeq}_${Math.random().toString(36).slice(2, 8)}`;
      const isoTimestamp = new Date(timestamp || Date.now()).toISOString();
      const payloadString = typeof data === 'string' ? data : JSON.stringify(data || {});

      // 2. Insert into canonical `events` table
      this.db.query(`
        INSERT OR IGNORE INTO events (
          event_id, event_type, event_version, causation_id, correlation_id,
          aggregate_type, aggregate_id, aggregate_version, timestamp, data, metadata, created_ts
        ) VALUES (
          ?, ?, 1, NULL, NULL,
          'run', ?, ?, ?, ?, '{}', strftime('%s','now')
        )
      `).run(eventId, type, runId, finalSeq, isoTimestamp, payloadString);

      // 3. Insert into canonical `event_outbox` table in the SAME atomic transaction
      const outboxId = `outbox_${eventId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const idempotencyKey = `outbox_key_${runId}_${finalSeq}_${eventId}`;

      this.db.query(`
        INSERT OR IGNORE INTO event_outbox (
          id, event_id, event_type, aggregate_id, data, status, idempotency_key, source_component, created_ts
        ) VALUES (
          ?, ?, ?, ?, ?, 'pending', ?, 'streaming', strftime('%s','now')
        )
      `).run(outboxId, eventId, type, runId, payloadString, idempotencyKey);

      return finalSeq;
    });
  }

  /**
   * Fetch historical events for a run aggregate after a specific sequence.
   */
  getEventsAfter(runId: string, afterSequence: number): any[] {
    const rows = this.db.query(`
      SELECT global_sequence, event_id, event_type, aggregate_version, timestamp, data
      FROM events
      WHERE aggregate_type = 'run' AND aggregate_id = ? AND aggregate_version > ?
      ORDER BY aggregate_version ASC
    `).all(runId, afterSequence) as Array<{
      global_sequence: number;
      event_id: string;
      event_type: string;
      aggregate_version: number;
      timestamp: string;
      data: string;
    }>;

    return rows.map(r => {
      let parsedData: any = {};
      try {
        parsedData = JSON.parse(r.data);
      } catch {
        parsedData = { raw: r.data };
      }
      return {
        id: r.global_sequence,
        eventId: r.event_id,
        runId,
        sequence: r.aggregate_version,
        type: r.event_type,
        data: parsedData,
        timestamp: r.timestamp,
      };
    });
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
