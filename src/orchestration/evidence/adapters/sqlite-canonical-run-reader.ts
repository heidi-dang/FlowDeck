/**
 * SQLite-backed canonical run reader.
 *
 * Reads the authoritative canonical run from the frozen v0.2.6 `task_runs`
 * table. This is the ONLY way the evidence import adapter learns the run's
 * current SHA and state — arbitrary caller-provided run-like strings are
 * never accepted as proof of canonical existence.
 */

import type { Database } from "bun:sqlite";
import type { CanonicalRun, CanonicalRunReader, CanonicalRunState } from "../ports/canonical-run-reader";

const ELIGIBLE_STATES: readonly string[] = [
  "created",
  "planning",
  "analysing",
  "delegating",
  "executing",
  "verifying",
  "recovering",
];

const TERMINAL_STATES: readonly string[] = ["completed", "failed", "cancelled"];

interface TaskRunRow {
  run_id: string;
  contract_id: string;
  strategy: string;
  state: string;
  baseline_sha: string;
  current_sha: string | null;
  verification_sha: string | null;
  completion_sha: string | null;
  repo_branch: string;
}

export class SqliteCanonicalRunReader implements CanonicalRunReader {
  constructor(private readonly db: Database) {}

  async getRunById(runId: string): Promise<CanonicalRun | undefined> {
    const row = this.db.query(
      "SELECT run_id, contract_id, strategy, state, baseline_sha, current_sha, verification_sha, completion_sha, repo_branch FROM task_runs WHERE run_id = ?",
    ).get(runId) as TaskRunRow | undefined;

    if (!row) return undefined;

    return {
      runId: row.run_id,
      contractId: row.contract_id,
      strategy: row.strategy,
      state: row.state as CanonicalRunState,
      baselineSha: row.baseline_sha,
      currentSha: row.current_sha,
      verificationSha: row.verification_sha,
      completionSha: row.completion_sha,
      repoBranch: row.repo_branch,
    };
  }

  /** Returns true when the run state is eligible to receive evidence. */
  isEligibleState(state: string): boolean {
    return ELIGIBLE_STATES.includes(state);
  }

  /** Returns true when the run state is terminal (completed/failed/cancelled). */
  isTerminalState(state: string): boolean {
    return TERMINAL_STATES.includes(state);
  }
}

export { ELIGIBLE_STATES, TERMINAL_STATES };
