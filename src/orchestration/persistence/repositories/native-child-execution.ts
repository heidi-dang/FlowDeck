import type { Database } from "bun:sqlite";
import type { TransactionManager } from "../transaction-manager";
import { BaseRepository } from "./repository";

export type ChildExecutionState =
  | "queued"
  | "running"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "unknown";

export interface ChildExecutionRecord {
  executionId: string;
  runId: string;
  assignmentId: string;
  taskCallId: string;
  /** Persisted routing SpecialistSpec identity when the native Task came from a specialist plan. */
  specialistId?: string;
  parentSessionId: string;
  childSessionId?: string;
  agentId: string;
  status: ChildExecutionState;
  background: boolean;
  prompt?: string;
  description?: string;
  result?: string;
  error?: string;
  cancelRequested?: boolean;
  nativeTerminationConfirmed?: boolean;
  startedAt: string;
  completedAt?: string | null;
}

export class SqliteNativeChildExecutionRepository extends BaseRepository {
  constructor(db: Database, tx: TransactionManager) {
    super(db, tx);
  }

  save(record: ChildExecutionRecord): void {
    this.tx.write(() => {
      const key = `child_exec:${record.taskCallId}`;
      const val = JSON.stringify(record);
      this.db.query(
        `INSERT INTO execution_metadata (id, run_id, session_id, key, value, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(run_id, key) DO UPDATE SET value = excluded.value`
      ).run(
        `meta-${record.executionId}`,
        record.runId,
        record.childSessionId ?? null,
        key,
        val
      );
    });
  }

  listAll(runId?: string): ChildExecutionRecord[] {
    const rows = runId
      ? this.db.query("SELECT * FROM execution_metadata WHERE run_id = ? AND key LIKE 'child_exec:%'").all(runId)
      : this.db.query("SELECT * FROM execution_metadata WHERE key LIKE 'child_exec:%'").all();

    const results: ChildExecutionRecord[] = [];
    for (const row of rows as any[]) {
      try {
        const parsed = JSON.parse(row.value) as ChildExecutionRecord;
        if (parsed && parsed.taskCallId && parsed.executionId && parsed.assignmentId) {
          results.push(parsed);
        }
      } catch {
        // Skip malformed individual rows on read
      }
    }
    return results;
  }

  findByTaskCallId(taskCallId: string, runId?: string): ChildExecutionRecord | null {
    const row = runId
      ? (this.db.query("SELECT * FROM execution_metadata WHERE run_id = ? AND key = ?").get(runId, `child_exec:${taskCallId}`) as any)
      : (this.db.query("SELECT * FROM execution_metadata WHERE key = ?").get(`child_exec:${taskCallId}`) as any);
    if (!row) return null;
    try {
      return JSON.parse(row.value) as ChildExecutionRecord;
    } catch {
      return null;
    }
  }

  delete(taskCallId: string, runId?: string): boolean {
    return this.tx.write(() => {
      const res = runId
        ? this.db.query("DELETE FROM execution_metadata WHERE run_id = ? AND key = ?").run(runId, `child_exec:${taskCallId}`)
        : this.db.query("DELETE FROM execution_metadata WHERE key = ?").run(`child_exec:${taskCallId}`);
      return res.changes > 0;
    });
  }
}
