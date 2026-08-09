/**
 * SQLite-backed replay repository implementing IReplayRepository.
 *
 * Persists replay records in the `replays` table (migration v2). Every
 * operation runs inside a TransactionManager for atomicity.
 */

import type { Database } from "bun:sqlite";
import type { TransactionManager } from "../transaction-manager";
import type { IReplayRepository, PaginatedResult } from "../../services/ports";
import type { Replay, ReplayStatus } from "../../types/replay";
import type { OrchestrationEvent } from "../../types/events";
import type { PagePaginationRequest } from "../../types/pagination";

function rowToReplay(row: Record<string, unknown>): Replay {
  return {
    id: row.id as string,
    sourceRunId: row.source_run_id as string,
    correlationId: row.correlation_id as string,
    causationId: (row.causation_id as string) ?? undefined,
    status: row.status as ReplayStatus,
    eventCount: (row.event_count as number) ?? 0,
    processedCount: (row.processed_count as number) ?? 0,
    failedCount: (row.failed_count as number) ?? 0,
    reason: (row.reason as string) ?? undefined,
    result: safeParseJSON(row.result as string),
    metadata: safeParseJSON(row.metadata as string),
    events: safeParseJSONArray(row.events as string) as OrchestrationEvent[],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completedAt: (row.completed_at as string) ?? undefined,
  };
}

function safeParseJSON(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeParseJSONArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const REPLAY_UPDATABLE_COLUMNS: Record<string, string> = {
  status: "status",
  eventCount: "event_count",
  processedCount: "processed_count",
  failedCount: "failed_count",
  reason: "reason",
  result: "result",
  metadata: "metadata",
  events: "events",
  updatedAt: "updated_at",
  completedAt: "completed_at",
};

export class SqliteReplayRepository implements IReplayRepository {
  constructor(
    private readonly db: Database,
    private readonly tx: TransactionManager,
  ) {}

  async create(replay: Replay): Promise<Replay> {
    return this.tx.write(() => {
      this.db
        .query(
          `INSERT INTO replays
             (id, source_run_id, correlation_id, causation_id, status,
              event_count, processed_count, failed_count, reason,
              result, metadata, events, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          replay.id,
          replay.sourceRunId,
          replay.correlationId,
          replay.causationId ?? null,
          replay.status,
          replay.eventCount ?? 0,
          replay.processedCount ?? 0,
          replay.failedCount ?? 0,
          replay.reason ?? null,
          JSON.stringify(replay.result ?? {}),
          JSON.stringify(replay.metadata ?? {}),
          JSON.stringify(replay.events ?? []),
          replay.createdAt,
          replay.updatedAt,
          replay.completedAt ?? null,
        );
      const row = this.db.query("SELECT * FROM replays WHERE id = ?").get(replay.id) as Record<string, unknown>;
      return rowToReplay(row);
    });
  }

  async update(id: string, patch: Partial<Replay>): Promise<Replay | null> {
    return this.tx.write(() => {
      const existing = this.db.query("SELECT * FROM replays WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!existing) return null;

      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      for (const [key, column] of Object.entries(REPLAY_UPDATABLE_COLUMNS)) {
        if (patch[key as keyof Replay] === undefined) continue;
        const value = patch[key as keyof Replay];
        if (key === "result" || key === "metadata") {
          sets.push(`${column} = ?`);
          vals.push(JSON.stringify(value ?? {}));
        } else {
          sets.push(`${column} = ?`);
          vals.push((value as string | number | null) ?? null);
        }
      }
      if (sets.length === 0) return rowToReplay(existing);

      vals.push(id);
      this.db.query(`UPDATE replays SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

      const row = this.db.query("SELECT * FROM replays WHERE id = ?").get(id) as Record<string, unknown>;
      return rowToReplay(row);
    });
  }

  async findById(id: string): Promise<Replay | null> {
    return this.tx.read(() => {
      const row = this.db.query("SELECT * FROM replays WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? rowToReplay(row) : null;
    });
  }

  async findMany(pagination: PagePaginationRequest): Promise<PaginatedResult<Replay>> {
    return this.tx.read(() => {
      const page = pagination.page ?? 1;
      const limit = pagination.limit ?? 20;
      const offset = (page - 1) * limit;
      const countRow = this.db.query("SELECT COUNT(*) AS c FROM replays").get() as { c: number };
      const rows = this.db
        .query("SELECT * FROM replays ORDER BY created_at DESC LIMIT ? OFFSET ?")
        .all(limit, offset) as Record<string, unknown>[];
      return { items: rows.map(rowToReplay), total: countRow.c, page, limit };
    });
  }

  async count(): Promise<number> {
    return this.tx.read(() => {
      const row = this.db.query("SELECT COUNT(*) AS c FROM replays").get() as { c: number };
      return row.c;
    });
  }
}
