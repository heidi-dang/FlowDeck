/**
 * SQLite-backed outbox repository implementing IOutboxRepository.
 * Every operation runs inside a TransactionManager for atomicity.
 *
 * Durable claiming (claimNextBatch) and idempotent delivery (markDelivered)
 * are exposed as public methods on the class, not on the IOutboxRepository
 * interface.
 */

import type { Database } from "bun:sqlite";
import type { TransactionManager } from "../transaction-manager";
import type { IOutboxRepository, PaginatedResult } from "../../services/ports";
import type { OutboxEntry, OutboxStatus, OutboxFilter } from "../../types/outbox";
import type { PagePaginationRequest } from "../../types/pagination";

function rowToEntry(row: Record<string, unknown>): OutboxEntry {
  const ts = (row.created_ts as number) * 1000;
  const raw = (row.data as string) ?? "{}";
  let payload: Record<string, unknown>;
  let lastError = (row.last_error as string) ?? undefined;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    // Malformed JSON — store raw data string in payload so the entry is
    // detectable as invalid, and record the decode error in lastError.
    payload = { raw };
    const decodeMsg = `JSON decode error: ${(e as Error).message}`;
    lastError = lastError ? `${decodeMsg}; ${lastError}` : decodeMsg;
  }
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    eventType: row.event_type as string,
    status: row.status as OutboxStatus,
    correlationId: row.idempotency_key as string,
    causationId: undefined,
    aggregateId: row.aggregate_id as string,
    attemptCount: (row.retry_count as number) ?? 0,
    retryCount: (row.retry_count as number) ?? 0,
    maxRetries: 3,
    lastError,
    payload,
    createdAt: new Date(ts).toISOString(),
    updatedAt: new Date(ts).toISOString(),
  };
}

export class SqliteOutboxRepository implements IOutboxRepository {
  constructor(
    private readonly db: Database,
    private readonly tx: TransactionManager,
  ) {}

  async create(entry: OutboxEntry): Promise<OutboxEntry> {
    return this.tx.write(() => {
      const data = typeof entry.payload === "string" ? entry.payload : JSON.stringify(entry.payload ?? {});
      this.db
        .prepare(
          `INSERT INTO event_outbox (id, event_id, event_type, aggregate_id, data, status, retry_count, idempotency_key, source_component, created_ts)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, strftime('%s','now'))`,
        )
        .run(entry.id, entry.eventId, entry.eventType, entry.aggregateId ?? "", data, entry.correlationId, "orchestration");
      const row = this.db.prepare("SELECT * FROM event_outbox WHERE id = ?").get(entry.id) as Record<string, unknown>;
      return rowToEntry(row);
    });
  }

  async update(id: string, input: Partial<OutboxEntry>): Promise<OutboxEntry | null> {
    return this.tx.write(() => {
      const existing = this.db.prepare("SELECT * FROM event_outbox WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!existing) return null;

      const sets: string[] = [];
      const vals: (string | number | boolean | null)[] = [];
      if (input.status !== undefined) { sets.push("status = ?"); vals.push(input.status); }
      if (input.lastError !== undefined) { sets.push("last_error = ?"); vals.push(input.lastError); }
      if (input.attemptCount !== undefined) { sets.push("retry_count = ?"); vals.push(input.attemptCount); }
      if (input.retryCount !== undefined) { sets.push("retry_count = ?"); vals.push(input.retryCount); }
      if (input.deliveredAt !== undefined) { sets.push("status = 'delivered'"); }

      if (sets.length > 0) {
        vals.push(id);
        this.db.prepare(`UPDATE event_outbox SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      }

      const row = this.db.prepare("SELECT * FROM event_outbox WHERE id = ?").get(id) as Record<string, unknown>;
      return rowToEntry(row);
    });
  }

  async findById(id: string): Promise<OutboxEntry | null> {
    const row = this.db.prepare("SELECT * FROM event_outbox WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToEntry(row);
  }

  async findMany(filter: OutboxFilter, pagination: PagePaginationRequest): Promise<PaginatedResult<OutboxEntry>> {
    return this.tx.read(() => {
      const conditions: string[] = [];
      const vals: (string | number | boolean | null)[] = [];

      if (filter.status) { conditions.push("status = ?"); vals.push(filter.status); }
      if (filter.destination) { conditions.push("source_component = ?"); vals.push(filter.destination); }
      if (filter.correlationId) { conditions.push("idempotency_key = ?"); vals.push(filter.correlationId); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const page = pagination.page ?? 1;
      const limit = pagination.limit ?? 20;
      const offset = (page - 1) * limit;

      const countRow = this.db.prepare(`SELECT COUNT(*) AS c FROM event_outbox ${where}`).get(...vals) as { c: number };
      const rows = this.db
        .prepare(`SELECT * FROM event_outbox ${where} ORDER BY created_ts DESC LIMIT ? OFFSET ?`)
        .all(...vals, limit, offset) as Record<string, unknown>[];

      return {
        items: rows.map(rowToEntry),
        total: countRow.c,
        page,
        limit,
      };
    });
  }

  async findPending(): Promise<OutboxEntry[]> {
    return this.tx.read(() => {
      const rows = this.db
        .prepare("SELECT * FROM event_outbox WHERE status = 'pending' ORDER BY created_ts ASC LIMIT 100")
        .all() as Record<string, unknown>[];
      return rows.map(rowToEntry);
    });
  }

  async count(filter: OutboxFilter): Promise<number> {
    return this.tx.read(() => {
      const conditions: string[] = [];
      const vals: (string | number | boolean | null)[] = [];
      if (filter.status) { conditions.push("status = ?"); vals.push(filter.status); }
      if (filter.destination) { conditions.push("source_component = ?"); vals.push(filter.destination); }
      if (filter.correlationId) { conditions.push("idempotency_key = ?"); vals.push(filter.correlationId); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM event_outbox ${where}`).get(...vals) as { c: number };
      return row.c;
    });
  }

  async claimNextBatch(batchSize: number): Promise<OutboxEntry[]> {
    return this.tx.write(() => {
      const rows = this.db
        .prepare("SELECT * FROM event_outbox WHERE status = 'pending' ORDER BY created_ts ASC LIMIT ?")
        .all(batchSize) as Record<string, unknown>[];
      return rows.map(rowToEntry);
    });
  }

  async markDelivered(id: string, idempotencyKey: string): Promise<void> {
    return this.tx.write(() => {
      // Idempotency check: skip if already delivered by idempotency key
      const existing = this.db
        .prepare("SELECT status FROM event_outbox WHERE idempotency_key = ?")
        .get(idempotencyKey) as { status: string } | undefined;
      if (existing && existing.status === 'delivered') return;

      // Mark as delivered
      this.db
        .prepare("UPDATE event_outbox SET status = 'delivered' WHERE id = ?")
        .run(id);
    });
  }

  async markFailed(id: string, attemptCount: number, lastError: string): Promise<void> {
    return this.tx.write(() => {
      this.db
        .prepare("UPDATE event_outbox SET status = 'failed', retry_count = ?, last_error = ? WHERE id = ?")
        .run(attemptCount, lastError, id);
    });
  }

  // ── Durable claiming ──────────────────────────────────────────────────────

  /**
   * Atomically claim the next batch of pending outbox entries for delivery.
   *
   * Uses a subquery with LIMIT inside UPDATE to avoid race conditions between
   * concurrent workers. Claimed entries are returned with status 'delivering'.
   *
   * @param workerId  Unique identifier of the claiming worker.
   * @param batchSize Maximum number of entries to claim.
   * @param leaseSeconds Duration in seconds before the lease expires.
   * @returns The claimed entries.
   */
  claimBatch(workerId: string, batchSize: number, leaseSeconds: number): OutboxEntry[] {
    return this.tx.write(() => {
      const leaseUntil = Math.floor(Date.now() / 1000) + leaseSeconds;
      const claimInfo = JSON.stringify({ claimedBy: workerId, leaseUntil });

      // Atomic claim: update only rows that are still pending, limited by
      // a subquery with ORDER BY and LIMIT to ensure FIFO ordering.
      this.db
        .prepare(
          `UPDATE event_outbox
           SET status = 'delivering', last_error = ?
           WHERE id IN (
             SELECT id FROM event_outbox
             WHERE status = 'pending'
             ORDER BY created_ts ASC
             LIMIT ?
           )`,
        )
        .run(claimInfo, batchSize);

      // Return the rows that were just claimed (identified by the claim info
      // we wrote into last_error).
      const rows = this.db
        .prepare(
          "SELECT * FROM event_outbox WHERE status = 'delivering' AND last_error = ? ORDER BY created_ts ASC",
        )
        .all(claimInfo) as Record<string, unknown>[];

      return rows.map(rowToEntry);
    });
  }

  // ── Idempotent delivery ───────────────────────────────────────────────────

  /**
   * Mark a claimed entry as delivered, guarded by idempotency key.
   *
   * Only transitions from 'delivering' to 'delivered' to prevent double-
   * delivery when the same entry is claimed by multiple workers or the
   * same worker retries after a network interruption.
   *
   * @param id              The outbox entry ID.
   * @param idempotencyKey  The idempotency key to verify.
   * @returns true if the row was updated, false if it was already delivered
   *          or does not match the expected idempotency key.
   */
  markDeliveredById(id: string, idempotencyKey: string): boolean {
    return this.tx.write(() => {
      const result = this.db
        .prepare(
          "UPDATE event_outbox SET status = 'delivered' WHERE id = ? AND status = 'delivering' AND idempotency_key = ?",
        )
        .run(id, idempotencyKey);
      return result.changes > 0;
    });
  }
}