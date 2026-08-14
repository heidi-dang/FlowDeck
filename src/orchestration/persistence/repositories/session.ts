/**
 * Persistent SQLite repository for agent_sessions table.
 */
import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../transaction-manager"
import { BaseRepository } from "./repository"

export interface AgentSessionRow {
  id: string
  runId: string
  assignmentId: string | null
  agentId: string
  parentSessionId: string | null
  depth: number
  status: string
  toolCalls: number
  delegations: number
  durationMs: number | null
  startedAt: string
  completedAt: string | null
  errorMessage: string | null
}

export interface CreateAgentSessionInput {
  id: string
  runId: string
  assignmentId?: string | null
  agentId: string
  parentSessionId?: string | null
  depth?: number
  status?: string
}

export class SqliteSessionRepository extends BaseRepository {
  constructor(db: Database, tx: TransactionManager) {
    super(db, tx)
  }

  create(input: CreateAgentSessionInput): AgentSessionRow {
    return this.tx.write(() => {
      this.db.query(
        `INSERT INTO agent_sessions (
          id, run_id, assignment_id, agent_id, parent_session_id, depth, status, tool_calls, delegations, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'))`
      ).run(
        input.id,
        input.runId,
        input.assignmentId ?? null,
        input.agentId,
        input.parentSessionId ?? null,
        input.depth ?? 0,
        input.status ?? "created"
      )
      return this.findById(input.id)!
    })
  }

  findById(id: string): AgentSessionRow | undefined {
    const row = this.db.query("SELECT * FROM agent_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined
    return row ? mapSessionRow(row) : undefined
  }

  findByRunId(runId: string): AgentSessionRow[] {
    const rows = this.db.query("SELECT * FROM agent_sessions WHERE run_id = ? ORDER BY started_at ASC").all(runId) as Record<string, unknown>[]
    return rows.map(mapSessionRow)
  }

  updateStatus(id: string, status: string, durationMs?: number, errorMessage?: string): boolean {
    return this.tx.write(() => {
      const res = errorMessage !== undefined || status === "completed" || status === "failed"
        ? this.db.query(
            `UPDATE agent_sessions 
             SET status = ?, duration_ms = ?, completed_at = datetime('now'), error_message = ? 
             WHERE id = ?`
          ).run(status, durationMs ?? null, errorMessage ?? null, id)
        : this.db.query(
            `UPDATE agent_sessions SET status = ? WHERE id = ?`
          ).run(status, id)
      return res.changes > 0
    })
  }

  incrementMetrics(id: string, toolCallsDelta: number = 0, delegationsDelta: number = 0): boolean {
    return this.tx.write(() => {
      const res = this.db.query(
        `UPDATE agent_sessions 
         SET tool_calls = tool_calls + ?, delegations = delegations + ? 
         WHERE id = ?`
      ).run(toolCallsDelta, delegationsDelta, id)
      return res.changes > 0
    })
  }
}

function mapSessionRow(r: Record<string, unknown>): AgentSessionRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    assignmentId: (r.assignment_id as string) ?? null,
    agentId: r.agent_id as string,
    parentSessionId: (r.parent_session_id as string) ?? null,
    depth: (r.depth as number) ?? 0,
    status: r.status as string,
    toolCalls: (r.tool_calls as number) ?? 0,
    delegations: (r.delegations as number) ?? 0,
    durationMs: (r.duration_ms as number) ?? null,
    startedAt: r.started_at as string,
    completedAt: (r.completed_at as string) ?? null,
    errorMessage: (r.error_message as string) ?? null,
  }
}
