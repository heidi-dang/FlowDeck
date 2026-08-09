/**
 * SQLite-backed durable delivery sink implementing IDeliverySink.
 *
 * Operates on the shared `event_outbox` table and is the single, idempotent,
 * lease-based delivery path for outbox entries:
 *
 *  - claimDue      atomically claims pending entries (or entries whose delivery
 *                  lease expired) for a worker, stamping a JSON lease
 *                  { workerId, leaseUntil } into last_error.
 *  - markDelivered idempotently transitions 'delivering' → 'delivered',
 *                  guarded by idempotency key so concurrent/retried workers
 *                  never double-deliver.
 *  - markFailed    records an attempt; requeues to 'pending' until maxRetries,
 *                  then transitions to 'failed'.
 *  - requeueExpiredLeases recovers entries stuck in 'delivering' after a
 *                  worker crash (lease expiry), returning them to 'pending'.
 *
 * All operations run inside a TransactionManager for atomicity.
 */

import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type { TransactionManager } from "../transaction-manager";
import type { DeliveryRecord, DeliveryStatus, IDeliverySink } from "../../services/ports";

const COLUMNS = [
  "id", "event_id", "event_type", "source_component", "data",
  "idempotency_key", "aggregate_id", "status", "retry_count", "last_error",
  "created_ts",
];

interface OutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  source_component: string | null;
  data: string | null;
  idempotency_key: string | null;
  aggregate_id: string | null;
  status: DeliveryStatus;
  retry_count: number;
  last_error: string | null;
  created_ts: number;
}

interface LeaseInfo {
  workerId?: string;
  leaseUntil?: number;
}

function rowToRecord(row: OutboxRow): DeliveryRecord {
  let lease: DeliveryRecord["lease"] = null;
  let lastError: string | undefined;
  if (row.last_error) {
    try {
      const parsed = JSON.parse(row.last_error) as LeaseInfo;
      if (parsed && typeof parsed.leaseUntil === "number") {
        lease = { workerId: parsed.workerId ?? "unknown", leaseUntil: parsed.leaseUntil };
      } else {
        lastError = row.last_error;
      }
    } catch {
      lastError = row.last_error;
    }
  }

  let payload: Record<string, unknown> = {};
  if (row.data) {
    try {
      payload = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      payload = { raw: row.data };
    }
  }

  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    destination: row.source_component ?? undefined,
    payload,
    correlationId: row.idempotency_key ?? "",
    aggregateId: row.aggregate_id ?? undefined,
    status: row.status,
    attemptCount: row.retry_count ?? 0,
    maxRetries: 3,
    lastError,
    idempotencyKey: row.idempotency_key ?? undefined,
    lease,
    createdAt: new Date((row.created_ts ?? 0) * 1000).toISOString(),
    updatedAt: new Date((row.created_ts ?? 0) * 1000).toISOString(),
  };
}

function mapRow(row: Record<string, unknown>): OutboxRow {
  return {
    id: row.id as string,
    event_id: row.event_id as string,
    event_type: row.event_type as string,
    source_component: (row.source_component as string) ?? null,
    data: (row.data as string) ?? null,
    idempotency_key: (row.idempotency_key as string) ?? null,
    aggregate_id: (row.aggregate_id as string) ?? null,
    status: row.status as DeliveryStatus,
    retry_count: (row.retry_count as number) ?? 0,
    last_error: (row.last_error as string) ?? null,
    created_ts: (row.created_ts as number) ?? 0,
  };
}

const SELECT_SQL = `SELECT ${COLUMNS.join(", ")} FROM event_outbox`;

export class SqliteDeliverySink implements IDeliverySink {
  constructor(
    private readonly db: Database,
    private readonly tx: TransactionManager,
  ) {}

  async claimDue(workerId: string, batchSize: number, leaseSeconds: number): Promise<DeliveryRecord[]> {
    return this.tx.write(() => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const leaseUntil = nowSeconds + leaseSeconds;
      const claimInfo = JSON.stringify({ workerId, leaseUntil });

      // Atomically claim pending entries OR entries whose lease has expired.
      this.db
        .query(
          `UPDATE event_outbox
           SET status = 'delivering', last_error = ?
           WHERE id IN (
             SELECT id FROM event_outbox
             WHERE status = 'pending'
                OR (status = 'delivering'
                    AND json_extract(last_error, '$.leaseUntil') IS NOT NULL
                    AND json_extract(last_error, '$.leaseUntil') < ?)
             ORDER BY created_ts ASC
             LIMIT ?
           )`,
        )
        .run(claimInfo, nowSeconds, batchSize);

      const rows = this.db
        .query(`${SELECT_SQL} WHERE status = 'delivering' AND last_error = ? ORDER BY created_ts ASC`)
        .all(claimInfo) as Record<string, unknown>[];
      return rows.map((r) => rowToRecord(mapRow(r)));
    });
  }

  async markDelivered(id: string, idempotencyKey?: string): Promise<boolean> {
    return this.tx.write(() => {
      // Idempotency guard: if THIS entry was already delivered under the same
      // idempotency key, treat the retried delivery as already done. Entries
      // with different ids (or unknown ids) must not short-circuit.
      if (idempotencyKey) {
        const existing = this.db
          .query("SELECT status FROM event_outbox WHERE id = ? AND idempotency_key = ? AND status = 'delivered'")
          .get(id, idempotencyKey) as { status: string } | undefined;
        if (existing) return true;
      }

      const result = this.db
        .query("UPDATE event_outbox SET status = 'delivered' WHERE id = ? AND status = 'delivering'")
        .run(id);
      return result.changes > 0;
    });
  }

  async markFailed(id: string, attemptCount: number, lastError: string, maxRetries: number): Promise<void> {
    return this.tx.write(() => {
      const nextStatus = attemptCount >= maxRetries ? "failed" : "pending";
      this.db
        .query("UPDATE event_outbox SET status = ?, retry_count = ?, last_error = ? WHERE id = ?")
        .run(nextStatus, attemptCount, lastError, id);
    });
  }

  async requeueExpiredLeases(nowSeconds?: number): Promise<number> {
    return this.tx.write(() => {
      const now = nowSeconds ?? Math.floor(Date.now() / 1000);
      const result = this.db
        .query(
          `UPDATE event_outbox
           SET status = 'pending', last_error = 'lease-expired-requeued'
           WHERE status = 'delivering'
             AND json_extract(last_error, '$.leaseUntil') IS NOT NULL
             AND json_extract(last_error, '$.leaseUntil') < ?`,
        )
        .run(now);
      return result.changes;
    });
  }

  async countByStatus(status: DeliveryStatus): Promise<number> {
    return this.tx.read(() => {
      const row = this.db.query("SELECT COUNT(*) AS c FROM event_outbox WHERE status = ?").get(status) as { c: number };
      return row.c;
    });
  }

  async recordDelivery(delivery: {
    eventId: string;
    destination: string;
    status: string;
    attempt: number;
    durationMs?: number;
    error?: string;
  }): Promise<void> {
    return this.tx.write(() => {
      const subscriberId = ensureSubscriber(this.db, delivery.destination);
      const { outboxId } = ensureEventAndOutbox(this.db, delivery.eventId);

      const nowTs = Math.floor(Date.now() / 1000);
      const deliveredAt = delivery.status === "delivered" ? new Date().toISOString() : null;
      const lastErrorTs = delivery.error ? new Date().toISOString() : null;

      const existing = this.db
        .query("SELECT id FROM event_deliveries WHERE outbox_id = ? AND subscriber_id = ?")
        .get(outboxId, subscriberId) as { id: string } | undefined;

      if (existing) {
        this.db
          .query(
            `UPDATE event_deliveries
             SET status = ?, delivery_attempts = ?, last_error = COALESCE(?, last_error),
                 last_error_ts = COALESCE(?, last_error_ts), delivered_at = COALESCE(?, delivered_at)
             WHERE id = ?`,
          )
          .run(
            delivery.status,
            delivery.attempt,
            delivery.error ?? null,
            lastErrorTs,
            deliveredAt,
            existing.id,
          );
      } else {
        const id = randomUUID();
        const idempotencyKey = `delivery-${id}`;
        this.db
          .query(
            `INSERT INTO event_deliveries (
               id, outbox_id, subscriber_id, status, delivery_attempts,
               last_error, last_error_ts, delivered_at, idempotency_key, created_ts
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            outboxId,
            subscriberId,
            delivery.status,
            delivery.attempt,
            delivery.error ?? null,
            lastErrorTs,
            deliveredAt,
            idempotencyKey,
            nowTs,
          );
      }
    });
  }

  async recordDeadLetter(deadLetter: {
    eventId: string;
    destination: string;
    reason: string;
    lastError?: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    return this.tx.write(() => {
      const subscriberId = ensureSubscriber(this.db, deadLetter.destination);
      const { outboxId, eventId } = ensureEventAndOutbox(this.db, deadLetter.eventId);

      let deliveryId: string;
      const existingDelivery = this.db
        .query("SELECT id FROM event_deliveries WHERE outbox_id = ? AND subscriber_id = ?")
        .get(outboxId, subscriberId) as { id: string } | undefined;

      if (existingDelivery) {
        deliveryId = existingDelivery.id;
        this.db
          .query("UPDATE event_deliveries SET status = 'dead_letter', last_error = ? WHERE id = ?")
          .run(deadLetter.reason, deliveryId);
      } else {
        deliveryId = randomUUID();
        const idempotencyKey = `dl-delivery-${deliveryId}`;
        const nowTs = Math.floor(Date.now() / 1000);
        this.db
          .query(
            `INSERT INTO event_deliveries (
               id, outbox_id, subscriber_id, status, delivery_attempts,
               last_error, idempotency_key, created_ts
             ) VALUES (?, ?, ?, 'dead_letter', 1, ?, ?, ?)`,
          )
          .run(deliveryId, outboxId, subscriberId, deadLetter.reason, idempotencyKey, nowTs);
      }

      const dlId = randomUUID();
      const nowTs = Math.floor(Date.now() / 1000);
      const payloadStr = JSON.stringify(deadLetter.payload ?? {});
      const errorHistory = JSON.stringify(deadLetter.lastError ? [deadLetter.lastError] : [deadLetter.reason]);

      this.db
        .query(
          `INSERT INTO dead_letter_events (
             id, delivery_id, event_id, subscriber_id, event_payload,
             error_history, final_error, status, created_ts
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unresolved', ?)`,
        )
        .run(
          dlId,
          deliveryId,
          eventId,
          subscriberId,
          payloadStr,
          errorHistory,
          deadLetter.reason,
          nowTs,
        );
    });
  }
}

function ensureSubscriber(db: Database, nameOrId: string): string {
  const existing = db
    .query("SELECT id FROM event_subscribers WHERE id = ? OR name = ? LIMIT 1")
    .get(nameOrId, nameOrId) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }
  const id = nameOrId;
  db.query(
    `INSERT OR IGNORE INTO event_subscribers (id, name, subscription_type, event_types, created_at)
     VALUES (?, ?, 'best_effort', '*', datetime('now'))`,
  ).run(id, nameOrId);
  return id;
}

function ensureEventAndOutbox(
  db: Database,
  eventIdOrOutboxId: string,
): { outboxId: string; eventId: string } {
  const existingOutbox = db
    .query("SELECT id, event_id FROM event_outbox WHERE id = ? OR event_id = ? LIMIT 1")
    .get(eventIdOrOutboxId, eventIdOrOutboxId) as { id: string; event_id: string } | undefined;

  if (existingOutbox) {
    const existingEvent = db
      .query("SELECT event_id FROM events WHERE event_id = ?")
      .get(existingOutbox.event_id) as { event_id: string } | undefined;
    if (!existingEvent) {
      db.query(
        `INSERT OR IGNORE INTO events (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, timestamp, data, created_ts)
         VALUES (?, 'dummy.type', 'dummy', ?, 1, datetime('now'), '{}', strftime('%s','now'))`,
      ).run(existingOutbox.event_id, existingOutbox.event_id);
    }
    return { outboxId: existingOutbox.id, eventId: existingOutbox.event_id };
  }

  const eventId = eventIdOrOutboxId.startsWith("evt-") ? eventIdOrOutboxId : `evt-${eventIdOrOutboxId}`;
  const outboxId = eventIdOrOutboxId;

  db.query(
    `INSERT OR IGNORE INTO events (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, timestamp, data, created_ts)
     VALUES (?, 'dummy.type', 'dummy', ?, 1, datetime('now'), '{}', strftime('%s','now'))`,
  ).run(eventId, eventId);

  db.query(
    `INSERT OR IGNORE INTO event_outbox (id, event_id, event_type, aggregate_id, data, status, created_ts, idempotency_key, source_component)
     VALUES (?, ?, 'dummy.type', ?, '{}', 'pending', strftime('%s','now'), ?, 'dummy')`,
  ).run(outboxId, eventId, outboxId, `key-${outboxId}`);

  return { outboxId, eventId };
}
