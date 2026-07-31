/** Repository for the worktrees table. Tracks git worktree ownership per run/assignment. */
import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../transaction-manager"
import { BaseRepository } from "./repository"

export interface WorktreeRow {
  id: string; runId: string; assignmentId: string | null; repositoryId: string
  path: string; branch: string; phase: number; status: string
  createdAt: string; mergedAt: string | null; conflictDetails: string | null
}

export class WorktreesRepository extends BaseRepository {
  constructor(db: Database, tx: TransactionManager) { super(db, tx) }

  create(input: { id: string; runId: string; repositoryId: string; path: string; branch: string; phase: number; assignmentId?: string }): WorktreeRow {
    return this.tx.write(() => {
      this.db.query(`INSERT INTO worktrees (id, run_id, assignment_id, repository_id, path, branch, phase, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))`)
        .run(input.id, input.runId, input.assignmentId ?? null, input.repositoryId, input.path, input.branch, input.phase)
      return this.findById(input.id)!
    })
  }

  findById(id: string): WorktreeRow | undefined {
    const r = this.db.query("SELECT * FROM worktrees WHERE id = ?").get(id) as Record<string, unknown> | undefined
    return r ? mapRow(r) : undefined
  }

  findByRun(runId: string): WorktreeRow[] {
    return (this.db.query("SELECT * FROM worktrees WHERE run_id = ? ORDER BY created_at").all(runId) as Record<string, unknown>[]).map(mapRow)
  }
}

function mapRow(r: Record<string, unknown>): WorktreeRow {
  return {
    id: r.id as string, runId: r.run_id as string, assignmentId: r.assignment_id as string | null,
    repositoryId: r.repository_id as string, path: r.path as string, branch: r.branch as string,
    phase: r.phase as number, status: r.status as string, createdAt: r.created_at as string,
    mergedAt: r.merged_at as string | null, conflictDetails: r.conflict_details as string | null,
  }
}
