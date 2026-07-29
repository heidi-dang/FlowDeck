/** Repository for append-only events, outbox, and subscriber persistence. */
import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../transaction-manager"
import { BaseRepository } from "./repository"

export interface EventRow {
  globalSequence: number; eventId: string; eventType: string; eventVersion: number
  causationId: string | null; correlationId: string | null
  aggregateType: string; aggregateId: string; aggregateVersion: number
  timestamp: string; data: string; metadata: string
}

export interface NewEventInput {
  eventId: string; eventType: string; aggregateType: string; aggregateId: string
  aggregateVersion: number; data: string; causationId?: string; correlationId?: string; metadata?: string
}

export interface OutboxRow {
  id: string; eventId: string; eventType: string; aggregateId: string; data: string
  status: string; idempotencyKey: string; sourceComponent: string
}

export class EventsRepository extends BaseRepository {
  constructor(db: Database, tx: TransactionManager) { super(db, tx) }

  append(event: NewEventInput): EventRow {
    return this.tx.write(() => {
      this.db.prepare(`INSERT INTO events (event_id, event_type, event_version, causation_id, correlation_id,
          aggregate_type, aggregate_id, aggregate_version, timestamp, data, metadata, created_ts)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, datetime('now'), ?, ?, strftime('%s','now'))`)
        .run(event.eventId, event.eventType, event.causationId ?? null, event.correlationId ?? null,
          event.aggregateType, event.aggregateId, event.aggregateVersion, event.data, event.metadata ?? '{}')
      return mapRow(this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(event.eventId) as Record<string, unknown>)
    })
  }

  queryRange(fromSeq: number, toSeq?: number): EventRow[] {
    let sql = "SELECT * FROM events WHERE global_sequence >= ?"
    const params: unknown[] = [fromSeq]
    if (toSeq !== undefined) { sql += " AND global_sequence <= ?"; params.push(toSeq) }
    sql += " ORDER BY global_sequence ASC"
    return (this.db.prepare(sql).all(...(params as [number])) as Record<string, unknown>[]).map(mapRow)
  }

  getMaxAggregateVersion(aggregateType: string, aggregateId: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(aggregate_version), 0) AS v FROM events WHERE aggregate_type = ? AND aggregate_id = ?")
      .get(aggregateType, aggregateId) as { v: number }
    return r.v
  }

  insertOutbox(input: { id: string; eventId: string; eventType: string; aggregateId: string; data: string; idempotencyKey: string; sourceComponent: string }): OutboxRow {
    return this.tx.write(() => {
      this.db.prepare(`INSERT INTO event_outbox (id, event_id, event_type, aggregate_id, data, status, idempotency_key, source_component, created_ts)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, strftime('%s','now'))`)
        .run(input.id, input.eventId, input.eventType, input.aggregateId, input.data, input.idempotencyKey, input.sourceComponent)
      return mapOutboxRow(this.db.prepare("SELECT * FROM event_outbox WHERE id = ?").get(input.id) as Record<string, unknown>)
    })
  }

  registerSubscriber(id: string, name: string, type: string, eventTypes: string): void {
    this.tx.write(() => {
      this.db.prepare("INSERT OR IGNORE INTO event_subscribers (id, name, subscription_type, event_types, created_at, is_active) VALUES (?, ?, ?, ?, datetime('now'), 1)")
        .run(id, name, type, eventTypes)
    })
  }
}

function mapRow(r: Record<string, unknown>): EventRow {
  return {
    globalSequence: r.global_sequence as number, eventId: r.event_id as string,
    eventType: r.event_type as string, eventVersion: r.event_version as number,
    causationId: r.causation_id as string | null, correlationId: r.correlation_id as string | null,
    aggregateType: r.aggregate_type as string, aggregateId: r.aggregate_id as string,
    aggregateVersion: r.aggregate_version as number, timestamp: r.timestamp as string,
    data: r.data as string, metadata: r.metadata as string,
  }
}

function mapOutboxRow(r: Record<string, unknown>): OutboxRow {
  return {
    id: r.id as string, eventId: r.event_id as string,
    eventType: r.event_type as string, aggregateId: r.aggregate_id as string,
    data: r.data as string, status: r.status as string,
    idempotencyKey: r.idempotency_key as string, sourceComponent: r.source_component as string,
  }
}
