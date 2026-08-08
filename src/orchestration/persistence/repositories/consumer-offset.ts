/**
 * Persistent SQLite repository for consumer_offsets table.
 */
import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../transaction-manager"
import { BaseRepository } from "./repository"

export interface ConsumerOffsetRow {
  subscriberId: string
  lastProcessedSequence: number
  lastProcessedAt: string
  status: "active" | "paused" | "blocked"
  pausedUntil: string | null
  blockedByEventId: string | null
}

export class SqliteConsumerOffsetRepository extends BaseRepository {
  constructor(db: Database, tx: TransactionManager) {
    super(db, tx)
  }

  setOffset(
    subscriberId: string,
    lastProcessedSequence: number,
    status: "active" | "paused" | "blocked" = "active"
  ): ConsumerOffsetRow {
    return this.tx.write(() => {
      this.db.query(
        `INSERT OR IGNORE INTO event_subscribers (id, name, subscription_type, event_types, created_at)
         VALUES (?, ?, 'durable_async', '["*"]', datetime('now'))`
      ).run(subscriberId, subscriberId)

      this.db.query(
        `INSERT INTO consumer_offsets (
          subscriber_id, last_processed_sequence, last_processed_at, status
        ) VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(subscriber_id) DO UPDATE SET
          last_processed_sequence = excluded.last_processed_sequence,
          last_processed_at = datetime('now'),
          status = excluded.status,
          paused_until = CASE WHEN excluded.status = 'active' THEN NULL ELSE paused_until END,
          blocked_by_event_id = CASE WHEN excluded.status = 'active' THEN NULL ELSE blocked_by_event_id END`
      ).run(subscriberId, lastProcessedSequence, status)

      return this.getOffset(subscriberId)!
    })
  }

  resetOffset(subscriberId: string, targetSequence: number = 0): ConsumerOffsetRow | undefined {
    return this.tx.write(() => {
      const existing = this.getOffset(subscriberId)
      if (!existing) return undefined
      
      this.db.query(
        `UPDATE consumer_offsets SET
          last_processed_sequence = ?,
          last_processed_at = datetime('now'),
          status = 'active',
          paused_until = NULL,
          blocked_by_event_id = NULL
         WHERE subscriber_id = ?`
      ).run(targetSequence, subscriberId)
      return this.getOffset(subscriberId)
    })
  }

  pauseOffset(subscriberId: string, until: Date): ConsumerOffsetRow | undefined {
    return this.tx.write(() => {
      const existing = this.getOffset(subscriberId)
      if (!existing) return undefined

      this.db.query(
        `UPDATE consumer_offsets SET
          status = 'paused',
          paused_until = ?
         WHERE subscriber_id = ?`
      ).run(until.toISOString(), subscriberId)
      return this.getOffset(subscriberId)
    })
  }

  blockOffset(subscriberId: string, eventId: string): ConsumerOffsetRow | undefined {
    return this.tx.write(() => {
      const existing = this.getOffset(subscriberId)
      if (!existing) return undefined

      this.db.query(
        `UPDATE consumer_offsets SET
          status = 'blocked',
          blocked_by_event_id = ?
         WHERE subscriber_id = ?`
      ).run(eventId, subscriberId)
      return this.getOffset(subscriberId)
    })
  }

  getOffset(subscriberId: string): ConsumerOffsetRow | undefined {
    const row = this.db.query("SELECT * FROM consumer_offsets WHERE subscriber_id = ?").get(subscriberId) as Record<string, unknown> | undefined
    return row ? mapOffsetRow(row) : undefined
  }

  listOffsets(): ConsumerOffsetRow[] {
    const rows = this.db.query("SELECT * FROM consumer_offsets ORDER BY subscriber_id ASC").all() as Record<string, unknown>[]
    return rows.map(mapOffsetRow)
  }
}

function mapOffsetRow(r: Record<string, unknown>): ConsumerOffsetRow {
  return {
    subscriberId: r.subscriber_id as string,
    lastProcessedSequence: r.last_processed_sequence as number,
    lastProcessedAt: r.last_processed_at as string,
    status: r.status as any,
    pausedUntil: (r.paused_until as string) ?? null,
    blockedByEventId: (r.blocked_by_event_id as string) ?? null,
  }
}
