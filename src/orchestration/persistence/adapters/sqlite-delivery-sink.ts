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
}
