/**
 * Port for loading authoritative completion data from persistence.
 *
 * The runtime integration `complete()` method uses this abstraction to obtain
 * all data needed for gate evaluation from durable storage rather than
 * trusting caller-supplied placeholder values.
 */

import type { TaskContract } from "../../contracts/task-contract.js";
import type { State } from "../../runtime/states.js";
import type {
  VerificationResultData,
  EvidenceData,
  CompletionDecisionData,
} from "../../runtime/state-store.js";

/**
 * Authoritative record of an assignment and its terminal status.
 *
 * `terminal` is true when the assignment has reached a terminal state
 * (succeeded, failed, or skipped) and is no longer in flight.
 */
export interface AssignmentStatusRecord {
  readonly id: string;
  readonly runId: string;
  readonly terminal: boolean;
}

/**
 * Authoritative approval state loaded from persistence.
 */
export interface ApprovalStateRecord {
  readonly id: string;
  readonly runId: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly approvedAt?: number;
  readonly approvedBy?: string;
}

/**
 * Authoritative override state loaded from persistence.
 */
export interface OverrideStateRecord {
  readonly id: string;
  readonly runId: string;
  readonly gateId: string;
  readonly reason: string;
  readonly active: boolean;
  readonly createdAt: number;
}

export interface CompletionRepositoryPort {
  /** Load the run's current state and version (for CAS check). */
  loadRunState(runId: string): Promise<{ state: State; version: number } | null>;

  /** Load the activated contract associated with a run. */
  loadContract(runId: string): Promise<TaskContract | null>;

  /** Load verification results persisted for the run. */
  loadVerificationResults(runId: string): Promise<VerificationResultData[]>;

  /** Load evidence items persisted for the run. */
  loadEvidence(runId: string): Promise<EvidenceData[]>;

  /** Load terminal status of all assignments for the run. */
  loadAssignmentStatuses(runId: string): Promise<AssignmentStatusRecord[]>;

  /** Load approval state persisted for the run. */
  loadApprovals(runId: string): Promise<ApprovalStateRecord[]>;

  /** Load override state persisted for the run. */
  loadOverrides(runId: string): Promise<OverrideStateRecord[]>;

  /** Load the latest persisted completion decision for the run (idempotency). */
  loadCompletionDecision(runId: string): Promise<CompletionDecisionData | null>;

  /** Persist a completion decision atomically. */
  saveCompletionDecision(decision: CompletionDecisionData): Promise<void>;

  /**
   * Resolve the current SHA at evaluation time.
   *
   * Resolves the working-tree HEAD of the run's workspace, returning the
   * full 40-character commit SHA. Falls back to the supplied fallback
   * SHA when git metadata is unavailable.
   */
  resolveCurrentSha(runId: string, fallbackSha: string): Promise<string>;
}
