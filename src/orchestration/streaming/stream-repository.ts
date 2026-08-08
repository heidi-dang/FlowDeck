import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { initializeDatabase, createTransactionManager, closeConnection, type TransactionManager } from '../persistence';
import { EventsRepository } from '../persistence/repositories/event';
import { type FlowDeckStreamEvent, createStreamEvent, normalizeEventType } from './stream-event';
import { validateStreamEvent } from './stream-event-schema';
import { getProjectIdentity } from '../../better-harness/workspace/project-identity';
import { getProjectStoreDir } from '../../better-harness/persistence/harness-store';

import { randomUUID } from 'crypto';

/**
 * Derive a project-isolated, absolute database path from the project root.
 * Uses SHA-256 of the normalized project root path to avoid CWD collisions.
 */
function deriveProjectDbPath(): string {
  const projectRoot = resolve(process.env.FLOWDECK_PROJECT_ROOT || process.cwd());
  const identity = getProjectIdentity(projectRoot);
  const storeDir = getProjectStoreDir(identity.projectId);
  mkdirSync(storeDir, { recursive: true });
  return join(storeDir, `flowdeck-${identity.projectId}.db`);
}

/**
 * Produce a canonical JSON representation with sorted keys for stable hashing.
 * Eliminates insertion-order key differences from idempotency comparisons.
 */
function canonicalHash(obj: unknown): string {
  const sorted = JSON.stringify(obj, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
  return createHash('sha256').update(sorted ?? 'null', 'utf8').digest('hex');
}
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
      let path = dbPathOrDb || process.env.FLOWDECK_DB_PATH || deriveProjectDbPath();
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
   * Rejects duplicate event IDs with conflict errors if any canonical field differs, and validates before persistence.
   */
  persistEvent(runId: string, sequence: number, type: string, data: any, timestamp: number): FlowDeckStreamEvent {
    return this.txManager.write(() => {
      const eventId = (data && data.eventId) ? data.eventId : `evt_${runId}_${randomUUID()}`;

      // 1. Check for duplicate eventId (strict idempotency check)
      const existing = this.db.query(`
        SELECT aggregate_version, data FROM events WHERE event_id = ?
      `).get(eventId) as { aggregate_version: number; data: string } | null;

      if (existing) {
        let existingData: any = {};
        try { existingData = JSON.parse(existing.data); } catch { /* ignore */ }

        const rawType = (typeof data === 'object' && (data as any).type) ? (data as any).type : (type || 'agent.progress');
        const normalizedType = normalizeEventType(rawType);
        const targetPayload = (typeof data === 'object' && data !== null && 'payload' in data) ? data.payload : data;

        // Compare all immutable canonical fields: runId, type, schemaVersion, occurredAt, payload
        const runIdMatches = existingData.runId === runId;
        const typeMatches = existingData.type === normalizedType;
        const schemaMatches = existingData.schemaVersion === (data.schemaVersion || 1);
        const occurredMatches = !data.occurredAt || existingData.occurredAt === data.occurredAt;
        const payloadMatches = canonicalHash(existingData.payload ?? {}) === canonicalHash(targetPayload ?? {});

        if (runIdMatches && typeMatches && schemaMatches && occurredMatches && payloadMatches) {
          return existingData as FlowDeckStreamEvent;
        }

        throw new Error(`DUPLICATE_EVENT_CONFLICT: Event ID '${eventId}' already exists with conflicting canonical fields.`);
      }

      // 2. Monotonic sequence allocation
      const currentMax = this.eventsRepo.getMaxAggregateVersion('run', runId);
      let finalSeq = (sequence && sequence > currentMax) ? sequence : currentMax + 1;

      // Ensure full canonical event representation is preserved in `data` column
      const rawType = (typeof data === 'object' && (data as any).type) ? (data as any).type : (type || 'agent.progress');
      const normalizedType = normalizeEventType(rawType);

      const eventObj: FlowDeckStreamEvent = createStreamEvent(
        (typeof data === 'object' && data.type && data.title)
          ? { ...data, type: normalizedType, sequence: finalSeq, runId, eventId }
          : {
              schemaVersion: 1,
              eventId,
              sequence: finalSeq,
              runId,
              occurredAt: new Date(timestamp || Date.now()).toISOString(),
              type: normalizedType,
              stage: 'execute',
              importance: 'normal',
              title: `Event ${eventId}`,
              payload: data,
            }
      );

      // 3. Pre-insert schema validation (must pass BEFORE writing to DB)
      const validation = validateStreamEvent(eventObj);
      if (!validation.success || !validation.data) {
        throw new Error(`Invalid stream event prior to persistence: ${validation.error || 'schema validation failed'}`);
      }

      const isoTimestamp = new Date(timestamp || Date.now()).toISOString();
      const payloadString = JSON.stringify(validation.data);

      // 4. Strict INSERT into `events` table (checking affected rows)
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

      // 5. Strict INSERT into `event_outbox` table in the SAME atomic transaction
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

      return validation.data;
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
      // event_outbox only has a status column — no delivered_at in this table
      this.db.query(`
        UPDATE event_outbox
        SET status = 'delivered'
        WHERE event_id = ?
      `).run(eventId);
    });
  }

  close(dbPath?: string): void {
    // Evict the path from the module-level connection cache BEFORE closing,
    // so a subsequent open on the same path gets a fresh Database instance.
    if (dbPath) {
      try { closeConnection(dbPath); } catch { /* ignore */ }
    } else {
      // Best-effort: close the raw DB handle if path is not supplied
      try { this.db.close(); } catch { /* ignore */ }
    }
  }

  getDb(): Database {
    return this.db;
  }
}
