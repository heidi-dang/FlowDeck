/**
 * SQLite-backed idempotency repository.
 *
 * Implements the canonical `IdempotencyRepository` port over the frozen
 * v0.2.6 `command_idempotency` table. Reservation-first semantics:
 *
 *  - INSERT with status 'executing' → acquired
 *  - existing 'executing'            → in_progress
 *  - existing 'completed' + hash     → completed (replay)
 *  - existing 'completed' + other    → conflict
 *  - existing 'failed'               → re-acquire (retry after interruption)
 *
 * The frozen v0.2.6 schema has no dedicated payload-hash column, so the
 * fingerprint is persisted in the existing `owner` field as a versioned
 * structured value (`fpx:<sha256>`) — the same "use existing fields for
 * metadata" rule applied to provenance. All operations run through the
 * injected TransactionManager so they participate in the caller's
 * transaction boundary.
 */

import type { Database } from "bun:sqlite";
import type { IdempotencyRepository, ReservationResult } from "../ports/idempotency-repository";
import { IdempotencyRecord } from "../domain/idempotency-record";
import type { Instant } from "../../common/types";
import type { TransactionManager } from "../../persistence/transaction-manager";

const FINGERPRINT_PREFIX = "fpx:";

interface IdempotencyRow {
  idempotency_key: string;
  command_type: string;
  aggregate_type: string;
  aggregate_id: string;
  status: string;
  owner: string | null;
  started_at: string;
  completed_at: string | null;
  event_id: string | null;
  completion_decision_id: string | null;
  error: string | null;
  created_ts: number;
}

function encodeFingerprint(payloadHash: string): string {
  return `${FINGERPRINT_PREFIX}${payloadHash}`;
}

function decodeFingerprint(owner: string | null): string {
  if (owner && owner.startsWith(FINGERPRINT_PREFIX)) return owner.slice(FINGERPRINT_PREFIX.length);
  return "";
}

function mapRow(row: IdempotencyRow): IdempotencyRecord {
  const status = row.status === "executing" ? "reserved" : row.status === "failed" ? "released" : "completed";
  const createdAt = row.started_at as Instant;
  const completedAt = row.completed_at as Instant | undefined;
  return new IdempotencyRecord({
    id: row.idempotency_key,
    commandType: row.command_type,
    taskRunId: row.aggregate_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: decodeFingerprint(row.owner),
    status,
    resultType: row.completion_decision_id ? "completion_decision" : row.event_id ? "event" : undefined,
    resultId: row.completion_decision_id ?? row.event_id ?? undefined,
    completedAt,
    createdAt,
  });
}

export class SqliteIdempotencyRepository implements IdempotencyRepository {
  constructor(
    private readonly db: Database,
    private readonly tx: TransactionManager,
  ) {}

  scopedKey(commandType: string, taskRunId: string, idempotencyKey: string): string {
    return `${commandType}:${taskRunId}:${idempotencyKey}`;
  }

  async tryReserve(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
    payloadHash: string,
    createdAt: Instant,
  ): Promise<ReservationResult> {
    const key = this.scopedKey(commandType, taskRunId, idempotencyKey);

    const existing = this.db.query(
      "SELECT * FROM command_idempotency WHERE idempotency_key = ?",
    ).get(key) as IdempotencyRow | undefined;

    if (existing) {
      if (existing.status === "completed") {
        const record = mapRow(existing);
        const storedHash = decodeFingerprint(existing.owner);
        if (storedHash && storedHash !== payloadHash) {
          return { status: "conflict", record, expectedPayloadHash: storedHash, actualPayloadHash: payloadHash };
        }
        return { status: "completed", record };
      }
      if (existing.status === "executing") {
        return { status: "in_progress", record: mapRow(existing) };
      }
      // failed → allow re-acquisition below
    }

    const record = new IdempotencyRecord({
      id: key,
      commandType,
      taskRunId,
      idempotencyKey,
      payloadHash,
      status: "reserved",
      createdAt,
    });

    this.tx.write(() => {
      this.db.query(
        `INSERT INTO command_idempotency
          (idempotency_key, command_type, aggregate_type, aggregate_id, status, owner, started_at, created_ts)
         VALUES (?, ?, 'task_run', ?, 'executing', ?, ?, strftime('%s','now'))`,
      ).run(key, commandType, taskRunId, encodeFingerprint(payloadHash), createdAt);
    });

    return { status: "acquired", record };
  }

  async completeReservation(
    commandType: string,
    taskRunId: string,
    idempotencyKey: string,
    resultType: string,
    resultId: string,
    completedAt: Instant,
  ): Promise<void> {
    const key = this.scopedKey(commandType, taskRunId, idempotencyKey);
    this.tx.write(() => {
      const r = this.db.query(
        `UPDATE command_idempotency
         SET status = 'completed', completed_at = ?, event_id = ?,
             completion_decision_id = CASE WHEN ? = 'completion_decision' THEN ? ELSE NULL END
         WHERE idempotency_key = ? AND status = 'executing'`,
      ).run(completedAt, resultId, resultType, resultId, key);
      if (r.changes === 0) {
        throw new Error(`No executing reservation for key ${key}`);
      }
    });
  }

  async releaseReservation(commandType: string, taskRunId: string, idempotencyKey: string): Promise<void> {
    const key = this.scopedKey(commandType, taskRunId, idempotencyKey);
    this.tx.write(() => {
      this.db.query(
        `UPDATE command_idempotency SET status = 'failed', error = 'released' WHERE idempotency_key = ? AND status = 'executing'`,
      ).run(key);
    });
  }

  async getByScopedKey(commandType: string, taskRunId: string, idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    const key = this.scopedKey(commandType, taskRunId, idempotencyKey);
    const row = this.db.query(
      "SELECT * FROM command_idempotency WHERE idempotency_key = ?",
    ).get(key) as IdempotencyRow | undefined;
    return row ? mapRow(row) : undefined;
  }
}
