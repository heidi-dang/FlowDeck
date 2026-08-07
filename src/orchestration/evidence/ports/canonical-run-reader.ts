/**
 * Canonical run reader port.
 *
 * Loads the authoritative canonical run (task_runs) that evidence imports
 * must be bound to. The adapter must NOT accept a caller-provided run id as
 * sufficient proof — it must load the run through this repository and
 * validate existence, identity, current SHA and eligibility.
 */

export type CanonicalRunState =
  | "created"
  | "planning"
  | "analysing"
  | "delegating"
  | "executing"
  | "verifying"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled";

export interface CanonicalRun {
  readonly runId: string;
  readonly contractId: string;
  readonly strategy: string;
  readonly state: CanonicalRunState;
  readonly baselineSha: string;
  readonly currentSha: string | null;
  readonly verificationSha: string | null;
  readonly completionSha: string | null;
  readonly repoBranch: string;
}

export interface CanonicalRunReader {
  /**
   * Loads the authoritative canonical run by its run id.
   * Returns undefined when no such canonical run exists.
   */
  getRunById(runId: string): Promise<CanonicalRun | undefined>;
}
