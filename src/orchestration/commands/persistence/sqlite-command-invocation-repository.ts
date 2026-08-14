import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../../persistence/transaction-manager"
import type { CommandInvocation, CommandInvocationStatus } from "../domain/command-definition"
import { commandRequestFingerprint } from "../domain/command-fingerprint"

export class CommandIdempotencyConflictError extends Error {
  constructor(message: string) { super(message); this.name = "CommandIdempotencyConflictError" }
}

export class SqliteCommandInvocationRepository {
  constructor(private readonly db: Database, private readonly tx: TransactionManager) {}

  async saveInvocation(invocation: CommandInvocation): Promise<void> {
    const inputJson = JSON.stringify(invocation.input ?? {})
    const fingerprint = invocation.requestFingerprint ?? commandRequestFingerprint(invocation.commandId, invocation.commandVersion, invocation.input)
    const terminalAt = ["completed", "failed", "cancelled"].includes(invocation.status) ? (invocation.completedAt ?? invocation.updatedAt) : null
    try {
      this.tx.write(() => {
        this.db.query(`
          INSERT INTO command_invocations
            (invocation_id, command_id, command_version, idempotency_key, request_fingerprint, input_json, status, task_run_id, plan_id, result_json, error_json, retry_count, created_at, updated_at, terminal_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(invocation_id) DO UPDATE SET
            status=excluded.status, task_run_id=excluded.task_run_id, plan_id=excluded.plan_id,
            result_json=excluded.result_json, error_json=excluded.error_json,
            retry_count=excluded.retry_count, updated_at=excluded.updated_at, terminal_at=excluded.terminal_at
        `).run(
          invocation.invocationId, invocation.commandId, invocation.commandVersion, invocation.idempotencyKey,
          fingerprint, inputJson, invocation.status, invocation.taskRunId ?? null, invocation.planId ?? null,
          invocation.result ? JSON.stringify(invocation.result) : null, invocation.error ? JSON.stringify(invocation.error) : null,
          invocation.retryCount, invocation.createdAt, invocation.updatedAt, terminalAt,
        )
      })
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: command_invocations.idempotency_key")) {
        const existing = await this.getByIdempotencyKey(invocation.idempotencyKey)
        if (existing && (existing.commandId !== invocation.commandId || existing.commandVersion !== invocation.commandVersion || existing.requestFingerprint !== fingerprint)) {
          throw new CommandIdempotencyConflictError("Idempotency key is already bound to an incompatible command request")
        }
        throw new Error("CONCURRENCY_CONFLICT")
      }
      throw error
    }
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<CommandInvocation | null> {
    const row = this.db.query("SELECT * FROM command_invocations WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown> | null
    return row ? this.map(row) : null
  }

  async getByInvocationId(invocationId: string): Promise<CommandInvocation | null> {
    const row = this.db.query("SELECT * FROM command_invocations WHERE invocation_id = ?").get(invocationId) as Record<string, unknown> | null
    return row ? this.map(row) : null
  }

  private map(row: Record<string, unknown>): CommandInvocation {
    const parse = (value: unknown): any => { try { return value ? JSON.parse(String(value)) : undefined } catch { return undefined } }
    return {
      invocationId: String(row.invocation_id), commandId: String(row.command_id), commandVersion: Number(row.command_version),
      idempotencyKey: String(row.idempotency_key), requestFingerprint: String(row.request_fingerprint),
      status: String(row.status) as CommandInvocationStatus, input: parse(row.input_json) ?? {},
      taskRunId: row.task_run_id ? String(row.task_run_id) : undefined, planId: row.plan_id ? String(row.plan_id) : undefined,
      result: parse(row.result_json), error: parse(row.error_json), retryCount: Number(row.retry_count),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), completedAt: row.terminal_at ? String(row.terminal_at) : undefined,
    }
  }
}
