/**
 * SQLite-backed TransactionalRunWriter.
 *
 * All methods are STRICTLY SYNCHRONOUS — they operate on the given Database
 * and TransactionManager directly, and are intended to be called inside a
 * UnitOfWork.execute() callback where the transaction is already active.
 */

import type { Database } from "bun:sqlite";
import type { TransactionManager } from "../transaction-manager";
import type { TransactionalRunWriter } from "../transactional-run-writer";
import type { Run, UpdateRunInput } from "../../types/runs";
import {
  mapRunStatusToTaskRunState,
  mapTaskRunStateToRunStatus,
  isValidPersistedPhase,
} from "../../types/runs";
import type { OrchestrationEvent } from "../../types/events";
import type { OutboxEntry } from "../../types/outbox";
import { OrchestrationError, ErrorCodes } from "../../types/errors";

export class SqliteTransactionalRunWriter implements TransactionalRunWriter {
  createRunWithEventAndOutbox(
    tx: TransactionManager,
    db: Database,
    run: Run,
    event: OrchestrationEvent,
    outboxEntry: OutboxEntry,
  ): Run {
    return tx.write(() => {
      // 1. Insert task_runs row
      const contractId = run.contractId ?? "contract-default";
      db.query(
        `INSERT OR IGNORE INTO contract_families (family_id, name, description, created_by, created_at)
         VALUES ('family-default', 'Default Family', 'Default contract family', 'system', datetime('now'))`,
      ).run();
      db.query(
        `INSERT OR IGNORE INTO task_contracts (contract_id, family_id, version, title, description, repo_url, repo_sha, created_by, created_at)
         VALUES (?, 'family-default', 1, 'Default Contract', 'Default contract description', 'https://github.com/heidi-dang/FlowDeck', '0000000000000000000000000000000000000000', 'system', datetime('now'))`,
      ).run(contractId);

      const state = mapRunStatusToTaskRunState(run.status);
      db.query(
        `INSERT INTO task_runs (run_id, contract_id, strategy, state, aggregate_version, baseline_sha, repo_branch, created_at, created_ts)
         VALUES (?, ?, ?, ?, 1, ?, ?, datetime('now'), strftime('%s','now'))`,
      ).run(
        run.id,
        contractId,
        ["simple","planned","delegated","audit","recovery"].includes(run.runType) ? run.runType : "simple",
        state,
        "0000000000000000000000000000000000000000",
        "main",
      );

      // 2. Insert events row
      const eventData = JSON.stringify(event.data ?? {});
      const eventMeta = JSON.stringify(event.metadata ?? {});
      db.query(
        `INSERT INTO events (event_id, event_type, event_version, causation_id, correlation_id, aggregate_type, aggregate_id, aggregate_version, timestamp, data, metadata, created_ts)
         VALUES (?, ?, 1, ?, ?, 'task_run', ?, ?, datetime('now'), ?, ?, strftime('%s','now'))`,
      ).run(
        event.id,
        event.type,
        event.causationId ?? null,
        event.correlationId,
        event.aggregateId ?? run.id,
        event.aggregateVersion ?? 1,
        eventData,
        eventMeta,
      );

      // 3. Insert event_outbox row
      const outboxData = JSON.stringify(outboxEntry.payload ?? {});
      db.query(
        `INSERT INTO event_outbox (id, event_id, event_type, aggregate_id, data, status, retry_count, idempotency_key, source_component, created_ts)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, 'orchestration', strftime('%s','now'))`,
      ).run(
        outboxEntry.id,
        outboxEntry.eventId,
        outboxEntry.eventType,
        outboxEntry.aggregateId ?? "",
        outboxData,
        outboxEntry.id,
      );

      // 4. Atomically persist authoritative correlation claim in execution_metadata
      if (run.correlationId) {
        db.query(`
          INSERT INTO execution_metadata (id, run_id, key, value, created_at)
          VALUES (?, ?, ?, ?, datetime('now'))
        `).run(
          "run_correlation:" + run.correlationId,
          run.id,
          "run_correlation:" + run.correlationId,
          run.id,
        );
      }

      return run;
    });
  }

  updateRunState(
    tx: TransactionManager,
    db: Database,
    id: string,
    input: UpdateRunInput,
    event: OrchestrationEvent,
    outboxEntry: OutboxEntry,
  ): Run {
    return tx.write(() => {
      // 1. Update task_runs state
      if (input.status !== undefined) {
        const taskRunState = mapRunStatusToTaskRunState(input.status);
        if (taskRunState === "completed") {
          throw OrchestrationError.fromCode(ErrorCodes.COMPLETION_POLICY_REQUIRED, {
            message: "Only CompletionPolicy may transition a Run to completed.",
          });
        }
        db.query(
          `UPDATE task_runs SET state = ?, aggregate_version = aggregate_version + 1 WHERE run_id = ?`,
        ).run(taskRunState, id);
      }

      // 2. Insert events row
      const eventData = JSON.stringify(event.data ?? {});
      const eventMeta = JSON.stringify(event.metadata ?? {});
      db.query(
        `INSERT INTO events (event_id, event_type, event_version, causation_id, correlation_id, aggregate_type, aggregate_id, aggregate_version, timestamp, data, metadata, created_ts)
         VALUES (?, ?, 1, ?, ?, 'task_run', ?, (SELECT COALESCE(MAX(aggregate_version), 0) + 1 FROM events WHERE aggregate_type = 'task_run' AND aggregate_id = ?), datetime('now'), ?, ?, strftime('%s','now'))`,
      ).run(
        event.id,
        event.type,
        event.causationId ?? null,
        event.correlationId,
        event.aggregateId ?? id,
        event.aggregateId ?? id,
        eventData,
        eventMeta,
      );

      // 3. Insert event_outbox row
      const outboxData = JSON.stringify(outboxEntry.payload ?? {});
      db.query(
        `INSERT INTO event_outbox (id, event_id, event_type, aggregate_id, data, status, retry_count, idempotency_key, source_component, created_ts)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, 'orchestration', strftime('%s','now'))`,
      ).run(
        outboxEntry.id,
        outboxEntry.eventId,
        outboxEntry.eventType,
        outboxEntry.aggregateId ?? "",
        outboxData,
        outboxEntry.id,
      );

      // 4. Read back the updated run
      const row = db.query("SELECT * FROM task_runs WHERE run_id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) {
        throw new Error(`Run ${id} not found after update`);
      }
      if (!isValidPersistedPhase(row.state as string)) {
        throw new Error(`INVALID_PERSISTED_PHASE: "${row.state}" is not a valid persisted orchestration phase.`);
      }
      const now = new Date().toISOString();
      const updated: Run = {
        id: row.run_id as string,
        status: mapTaskRunStateToRunStatus(row.state as string),
        runType: (row.strategy as string) ?? "simple",
        correlationId: id,
        contractId: (row.contract_id as string) ?? undefined,
        aggregateId: (row.run_id as string) ?? undefined,
        createdAt: (row.created_at as string) ?? now,
        updatedAt: now,
        startedAt: (row.started_at as string) ?? undefined,
        completedAt: (row.completed_at as string) ?? undefined,
        stage: input.stage,
        error: input.error ?? input.errorMessage,
        metadata: input.metadata,
      };
      return updated;
    });
  }
}