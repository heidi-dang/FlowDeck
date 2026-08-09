import type { Database } from "bun:sqlite";
import type { TransactionManager } from "../../persistence/transaction-manager";
import type { CommandInvocation, CommandInvocationStatus } from "../domain/command-definition";
import { createHash } from "crypto";

export interface CommandInvocationRecord {
  invocationId: string;
  commandId: string;
  commandVersion: number;
  idempotencyKey: string;
  inputHash: string;
  status: CommandInvocationStatus;
  inputJson: string;
  taskRunId?: string;
  contractId?: string;
  planId?: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  errorJson?: string;
}

export class SqliteCommandInvocationRepository {
  constructor(
    private readonly db: Database,
    private readonly tx: TransactionManager,
  ) {}

  /**
   * Save a new command invocation or update an existing one.
   */
  async saveInvocation(invocation: CommandInvocation): Promise<void> {
    const inputJson = JSON.stringify(invocation.input ?? {});
    const inputHash = createHash("sha256").update(inputJson).digest("hex");
    const errorJson = invocation.error ? JSON.stringify(invocation.error) : null;

    this.tx.write(() => {
      this.db
        .query(
          `INSERT INTO command_idempotency (
            idempotency_key, command_type, aggregate_type, aggregate_id, status, owner, started_at, completed_at, event_id, completion_decision_id, error, created_ts
          ) VALUES (?, ?, 'command_invocation', ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
          ON CONFLICT(idempotency_key) DO UPDATE SET
            status = excluded.status,
            completed_at = excluded.completed_at,
            error = excluded.error`,
        )
        .run(
          invocation.idempotencyKey,
          `${invocation.commandId}:v${invocation.commandVersion}`,
          invocation.invocationId,
          invocation.status === "completed" ? "completed" : invocation.status === "failed" || invocation.status === "cancelled" ? "failed" : "executing",
          JSON.stringify({
            invocationId: invocation.invocationId,
            commandId: invocation.commandId,
            commandVersion: invocation.commandVersion,
            inputHash,
            inputJson,
            taskRunId: invocation.taskRunId,
            contractId: invocation.contractId,
            planId: invocation.planId,
            retryCount: invocation.retryCount,
          }),
          invocation.createdAt,
          invocation.completedAt ?? null,
          invocation.taskRunId ?? null,
          null,
          errorJson,
        );
    });
  }

  /**
   * Get command invocation by idempotency key.
   */
  async getByIdempotencyKey(idempotencyKey: string): Promise<CommandInvocation | null> {
    const row = this.db
      .query(`SELECT * FROM command_idempotency WHERE idempotency_key = ?`)
      .get(idempotencyKey) as any;

    if (!row) return null;

    let ownerData: any = {};
    try {
      if (row.owner) ownerData = JSON.parse(row.owner);
    } catch {}

    const [commandId, versionStr] = (row.command_type ?? "").split(":v");
    const commandVersion = versionStr ? parseInt(versionStr, 10) : 1;

    let input: any = {};
    try {
      if (ownerData.inputJson) input = JSON.parse(ownerData.inputJson);
    } catch {}

    let error: any = undefined;
    try {
      if (row.error) error = JSON.parse(row.error);
    } catch {}

    let status: CommandInvocationStatus = "running";
    if (row.status === "completed") status = "completed";
    else if (row.status === "failed") status = "failed";

    return {
      invocationId: ownerData.invocationId ?? row.aggregate_id,
      commandId: ownerData.commandId ?? commandId,
      commandVersion: ownerData.commandVersion ?? commandVersion,
      idempotencyKey: row.idempotency_key,
      status,
      input,
      taskRunId: ownerData.taskRunId,
      contractId: ownerData.contractId,
      planId: ownerData.planId,
      retryCount: ownerData.retryCount ?? 0,
      createdAt: row.started_at,
      updatedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      error,
    };
  }
}
