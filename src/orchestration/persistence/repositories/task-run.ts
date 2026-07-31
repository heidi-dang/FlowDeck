/** Repository for task_runs and related run-scoped entities. */
import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../transaction-manager"
import { BaseRepository } from "./repository"

export interface TaskRunRow {
  runId: string; contractId: string; strategy: string; state: string
  aggregateVersion: number; baselineSha: string
  currentSha: string | null; verificationSha: string | null; completionSha: string | null
  repoBranch: string; workingTreeClean: boolean
  previousRunId: string | null; createdAt: string; startedAt: string | null; completedAt: string | null
}

export interface CreateTaskRunInput {
  runId: string; contractId: string; strategy: string; baselineSha: string; repoBranch: string
}

export class TaskRunsRepository extends BaseRepository {
  constructor(db: Database, tx: TransactionManager) { super(db, tx) }

  create(input: CreateTaskRunInput): TaskRunRow {
    return this.tx.write(() => {
      this.db.query(`INSERT INTO task_runs (run_id, contract_id, strategy, state, aggregate_version, baseline_sha, repo_branch, created_at, created_ts)
        VALUES (?, ?, ?, 'created', 1, ?, ?, datetime('now'), strftime('%s','now'))`)
        .run(input.runId, input.contractId, input.strategy, input.baselineSha, input.repoBranch)
      return this.findById(input.runId)!
    })
  }

  findById(id: string): TaskRunRow | undefined {
    const r = this.db.query("SELECT * FROM task_runs WHERE run_id = ?").get(id) as Record<string, unknown> | undefined
    return r ? mapRow(r) : undefined
  }

  findByState(state: string): TaskRunRow[] {
    return (this.db.query("SELECT * FROM task_runs WHERE state = ? ORDER BY created_at").all(state) as Record<string, unknown>[]).map(mapRow)
  }

  updateState(runId: string, state: string, sha?: string): boolean {
    return this.tx.write(() => {
      const r = sha
        ? this.db.query("UPDATE task_runs SET state = ?, current_sha = ? WHERE run_id = ?").run(state, sha, runId)
        : this.db.query("UPDATE task_runs SET state = ? WHERE run_id = ?").run(state, runId)
      return r.changes > 0
    })
  }
}

function mapRow(r: Record<string, unknown>): TaskRunRow {
  return {
    runId: r.run_id as string, contractId: r.contract_id as string,
    strategy: r.strategy as string, state: r.state as string,
    aggregateVersion: r.aggregate_version as number, baselineSha: r.baseline_sha as string,
    currentSha: r.current_sha as string | null, verificationSha: r.verification_sha as string | null,
    completionSha: r.completion_sha as string | null, repoBranch: r.repo_branch as string,
    workingTreeClean: (r.working_tree_clean as number) === 1,
    previousRunId: r.previous_run_id as string | null,
    createdAt: r.created_at as string, startedAt: r.started_at as string | null,
    completedAt: r.completed_at as string | null,
  }
}
