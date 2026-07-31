/**
 * TransactionalRunWriter — sync write operations for run state, events, and outbox.
 *
 * Every method is STRICTLY SYNCHRONOUS. Designed to be called inside a
 * UnitOfWork.execute() callback where the TransactionManager is available.
 * No async/await, no Promise — the caller is responsible for transaction
 * boundaries.
 */

import type { Database } from "bun:sqlite";
import type { TransactionManager } from "./transaction-manager";
import type { Run, UpdateRunInput } from "../types/runs";
import type { OrchestrationEvent } from "../types/events";
import type { OutboxEntry } from "../types/outbox";

export interface TransactionalRunWriter {
  /**
   * Atomically create a run row, insert the event, and enqueue the outbox
   * entry — all inside the active transaction.
   *
   * Returns the persisted Run object.
   */
  createRunWithEventAndOutbox(
    tx: TransactionManager,
    db: Database,
    run: Run,
    event: OrchestrationEvent,
    outboxEntry: OutboxEntry,
  ): Run;

  /**
   * Atomically update the run state, insert the status-change event, and
   * enqueue the outbox entry — all inside the active transaction.
   *
   * Returns the updated Run object.
   */
  updateRunState(
    tx: TransactionManager,
    db: Database,
    id: string,
    input: UpdateRunInput,
    event: OrchestrationEvent,
    outboxEntry: OutboxEntry,
  ): Run;
}