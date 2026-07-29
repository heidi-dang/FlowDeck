/**
 * SQLite-backed outbox repository implementing IOutboxRepository.
 * Every operation runs inside a TransactionManager for atomicity.
 */

import type { Database } from "bun:sqlite";
import type { TransactionManager } from "../transaction-manager";
import type { IOutboxRepository, PaginatedResult } from "../../services/ports";
import type { OutboxEntry, OutboxStatus, OutboxFilter } from "../../types/outbox";
import type { PagePaginationRequest } from "../../types/pagination";

function rowToEntry(row: Record<string, unknown>): OutboxEntry {
  const ts = (row.created_ts as number) * 1000;
  const raw = (row.data as string) ?? "{}";
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { /* use default */ }
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
    lastError: (row.last_error as string) ?? undefined,
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
      const vals: any[] = [];
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
      const vals: any[] = [];

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
      const vals: any[] = [];
      if (filter.status) { conditions.push("status = ?"); vals.push(filter.status); }
      if (filter.destination) { conditions.push("source_component = ?"); vals.push(filter.destination); }
      if (filter.correlationId) { conditions.push("idempotency_key = ?"); vals.push(filter.correlationId); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM event_outbox ${where}`).get(...vals) as { c: number };
      return row.c;
    });
  }
}