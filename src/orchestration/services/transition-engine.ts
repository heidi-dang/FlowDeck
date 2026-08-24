/**
 * RunTransitionEngine — Authoritative deterministic transition engine for FlowDeck runs.
 *
 * Enforces:
 * - Legal Run phase transitions via central transition table and mandatory CAS with aggregate versioning.
 * - Terminal state immutability (completed, failed, cancelled) with exclusive CompletionPolicy authority for completed.
 * - Progress-driven work-item / Assignment advancement.
 * - Durable attempt accounting and action repetition prevention with causal state linkage.
 * - Direct Heidi / Root execution lineage participation.
 * - Strategy constraint persistence & enforcement across restarts.
 * - Lineage-specific bounded transient retry vs change-strategy vs replan vs block.
 * - Parallel child convergence and recovery handling.
 * - Conservative default fallback (no false PROGRESS_CONFIRMED continuation).
 */

import type { Database } from "bun:sqlite";
import type { OrchestrationPhase } from "../types/runs";
import { OrchestrationPhase as OP } from "../types/runs";
import type { TaskRunsRepository } from "../persistence/repositories/task-run";
import type { SqliteAssignmentRepo } from "../composition";
import type { ProgressObservationService } from "./progress-observation-service";
import type { OrchestrationSnapshotService, OrchestrationSnapshot } from "./orchestration-snapshot-service";
import type { SqliteNativeChildExecutionRepository } from "../persistence/repositories/native-child-execution";
import type { TransactionManager } from "../persistence/transaction-manager";
import type { CompletionPolicy } from "./completion-policy";

export const LEGAL_PHASE_TRANSITIONS: Record<OrchestrationPhase, ReadonlyArray<OrchestrationPhase>> = {
  created: ["planning", "analysing", "executing", "cancelled", "failed"],
  planning: ["analysing", "delegating", "executing", "cancelled", "failed"],
  analysing: ["delegating", "executing", "planning", "cancelled", "failed"],
  delegating: ["executing", "recovering", "cancelled", "failed"],
  executing: ["verifying", "delegating", "recovering", "completed", "failed", "cancelled"],
  verifying: ["executing", "recovering", "completed", "failed", "cancelled"],
  recovering: ["executing", "delegating", "planning", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_PHASES: ReadonlySet<OrchestrationPhase> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isValidPhaseTransition(from: OrchestrationPhase, to: OrchestrationPhase): boolean {
  if (from === to) return true;
  if (TERMINAL_PHASES.has(from)) return false;
  const allowed = LEGAL_PHASE_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export type StrategyDecision =
  | "EXECUTE_CURRENT"
  | "RETRY_SAME_STRATEGY"
  | "CHANGE_STRATEGY"
  | "REPLAN"
  | "BLOCK";

export type TransitionReasonCode =
  | "CHILD_COMPLETED"
  | "CHILD_FAILED"
  | "ASSIGNMENT_COMPLETED"
  | "ASSIGNMENT_FAILED"
  | "PROGRESS_CONFIRMED"
  | "NEXT_WORK_ITEM_READY"
  | "NO_PROGRESS"
  | "REPEATED_ACTION_BLOCKED"
  | "TRANSIENT_RETRY_ALLOWED"
  | "STALL_DETECTED"
  | "RECOVERY_PROGRESS"
  | "VERIFICATION_REQUIRED"
  | "READY_FOR_VERIFICATION"
  | "VERIFICATION_PASSED"
  | "VERIFICATION_FAILED"
  | "VERIFICATION_STALE"
  | "ALL_WORK_ITEMS_COMPLETE"
  | "WAITING_FOR_CHILDREN"
  | "USER_CANCELLED"
  | "SUPERSEDED"
  | "BLOCKED"
  | "STRATEGY_SET_EXHAUSTED"
  | "TRANSITION_CONFLICT";

export interface AttemptRecord {
  runId: string;
  assignmentId: string;
  attemptNumber: number;
  callID?: string;
  tool: string;
  actionFingerprint: string;
  resultFingerprint?: string;
  preStateFingerprint: string;
  postStateFingerprint?: string;
  startedAt: string;
  finishedAt?: string;
  progressProduced: boolean;
  repositoryDelta: number;
  evidenceDelta: number;
  verificationDelta: number;
  childStateDelta: number;
  isTransientError?: boolean;
  failureReason?: string;
  evidenceIds: string[];
}

export interface StrategyConstraint {
  runId: string;
  assignmentId: string;
  prohibitedActionFingerprint: string;
  stateFingerprint: string;
  reason: string;
  createdAt: string;
  clearedAt?: string;
}

export interface StrategyConstraintSet {
  runId: string;
  assignmentId: string;
  stateFingerprint: string;
  prohibitedActionFingerprints: string[];
  reasonsByFingerprint?: Record<string, string>;
  exhausted: boolean;
  createdAt: string;
  updatedAt: string;
  clearedAt?: string;
}

export interface SaveStrategyConstraintInput {
  runId: string;
  assignmentId: string;
  prohibitedActionFingerprint: string;
  stateFingerprint: string;
  reason: string;
  createdAt?: string;
}

export interface TransitionEvaluationResult {
  runId: string;
  currentPhase: OrchestrationPhase;
  targetPhase?: OrchestrationPhase;
  phaseChanged: boolean;
  currentWorkItemId?: string;
  nextWorkItemId?: string;
  workItemChanged: boolean;
  strategyDecision: StrategyDecision;
  reasonCode: TransitionReasonCode;
  requiresAction: boolean;
  prohibitedActionFingerprint?: string;
  blockerReason?: string;
}

export interface TransitionPhaseCasInput {
  runId: string;
  targetPhase: OrchestrationPhase;
  expectedPhase: OrchestrationPhase;
  expectedAggregateVersion: number;
  authority?: "transition_engine" | "run_service";
  /** Unforgeable-at-call-site capability bound to the constructed CompletionPolicy. */
  completionPolicy?: CompletionPolicy;
  sha?: string;
}

export class RunTransitionEngine {
  constructor(
    private readonly db: Database,
    private readonly taskRunRepo: TaskRunsRepository,
    private readonly assignmentRepo: SqliteAssignmentRepo,
    private readonly nativeChildRepo: SqliteNativeChildExecutionRepository,
    private readonly progressService: ProgressObservationService,
    private readonly snapshotService: OrchestrationSnapshotService,
    private readonly txManager?: TransactionManager,
  ) {}

  private completionPolicyAuthority: CompletionPolicy | null = null;

  /** Composition binds exactly one policy instance after both collaborators exist. */
  bindCompletionPolicy(policy: CompletionPolicy): void {
    if (this.completionPolicyAuthority && this.completionPolicyAuthority !== policy) {
      throw new Error("COMPLETION_POLICY_ALREADY_BOUND");
    }
    this.completionPolicyAuthority = policy;
  }

  /**
   * Allocate the next atomic attempt number for a work item / Assignment / Root unit.
   */
  allocateNextAttemptNumber(runId: string, assignmentId: string): number {
    if (this.txManager) {
      return this.txManager.write(() => this._allocateNextAttemptNumberInner(runId, assignmentId));
    }
    return this._allocateNextAttemptNumberInner(runId, assignmentId);
  }

  private _allocateNextAttemptNumberInner(runId: string, assignmentId: string): number {
    const attempts = this.listAttempts(runId, assignmentId);
    let max = 0;
    for (const a of attempts) {
      if (a.attemptNumber > max) max = a.attemptNumber;
    }
    return max + 1;
  }

  /**
   * Atomically start and reserve an attempt record in SQLite.
   */
  startAttempt(input: {
    runId: string;
    assignmentId: string;
    callID: string;
    tool: string;
    actionFingerprint: string;
    preStateFingerprint: string;
    startedAt?: string;
  }): AttemptRecord {
    const fn = () => {
      // 1. Check if callID is already registered (idempotency check)
      const existingCall = this.db.query(
        "SELECT * FROM call_id_attempts WHERE call_id = ?"
      ).get(input.callID) as { run_id: string; assignment_id: string; attempt_number: number } | null;

      if (existingCall) {
        const existingAttempt = this.getAttempt(existingCall.run_id, existingCall.assignment_id, existingCall.attempt_number);
        if (existingAttempt) return existingAttempt;
      }

      // 2. Determine next atomic attempt number
      const attemptNumber = this._allocateNextAttemptNumberInner(input.runId, input.assignmentId);
      const startedAt = input.startedAt ?? new Date().toISOString();

      const attemptRecord: AttemptRecord = {
        runId: input.runId,
        assignmentId: input.assignmentId,
        attemptNumber,
        callID: input.callID,
        tool: input.tool,
        actionFingerprint: input.actionFingerprint,
        preStateFingerprint: input.preStateFingerprint,
        startedAt,
        progressProduced: false,
        repositoryDelta: 0,
        evidenceDelta: 0,
        verificationDelta: 0,
        childStateDelta: 0,
        evidenceIds: [],
      };

      const key = `attempt:${input.runId}:${input.assignmentId}:${attemptNumber}`;
      const val = JSON.stringify(attemptRecord);

      // Insert without upsert: fails if attempt key already exists
      this.db.query(
        `INSERT INTO execution_metadata (id, run_id, session_id, key, value, created_at)
         VALUES (?, ?, NULL, ?, ?, datetime('now'))`
      ).run(
        `meta-att-${input.runId}-${input.assignmentId}-${attemptNumber}`,
        input.runId,
        key,
        val
      );

      // Register callID correlation
      this.db.query(
        `INSERT INTO call_id_attempts (call_id, run_id, assignment_id, attempt_number, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(
        input.callID,
        input.runId,
        input.assignmentId,
        attemptNumber
      );

      return attemptRecord;
    };

    if (this.txManager) {
      return this.txManager.write(fn);
    }
    return fn();
  }

  /**
   * Find an unfinished or finished attempt durably by callID.
   */
  findAttemptByCallID(callID: string): AttemptRecord | null {
    const fn = () => {
      const row = this.db.query(
        "SELECT * FROM call_id_attempts WHERE call_id = ?"
      ).get(callID) as { run_id: string; assignment_id: string; attempt_number: number } | null;

      if (!row) return null;
      return this.getAttempt(row.run_id, row.assignment_id, row.attempt_number);
    };

    if (this.txManager) {
      return this.txManager.read(fn);
    }
    return fn();
  }

  /**
   * Get an attempt record by (runId, assignmentId, attemptNumber).
   */
  getAttempt(runId: string, assignmentId: string, attemptNumber: number): AttemptRecord | null {
    const key = `attempt:${runId}:${assignmentId}:${attemptNumber}`;
    const row = this.db.query(
      "SELECT value FROM execution_metadata WHERE run_id = ? AND key = ?"
    ).get(runId, key) as { value: string } | null;

    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  /**
   * Authoritative attempt recording. Persists attempt history durably in execution_metadata.
   */
  recordAttempt(attempt: AttemptRecord): void {
    const key = `attempt:${attempt.runId}:${attempt.assignmentId}:${attempt.attemptNumber}`;
    const val = JSON.stringify(attempt);

    this.db.query(
      `INSERT INTO execution_metadata (id, run_id, session_id, key, value, created_at)
       VALUES (?, ?, NULL, ?, ?, datetime('now'))
       ON CONFLICT(run_id, key) DO UPDATE SET value = excluded.value`
    ).run(
      `meta-att-${attempt.runId}-${attempt.assignmentId}-${attempt.attemptNumber}`,
      attempt.runId,
      key,
      val
    );
  }

  /**
   * Record attempt start state at tool.execute.before.
   */
  recordAttemptStart(attempt: {
    runId: string;
    assignmentId: string;
    attemptNumber: number;
    callID?: string;
    tool: string;
    actionFingerprint: string;
    preStateFingerprint: string;
    startedAt?: string;
  }): AttemptRecord {
    if (attempt.callID) {
      return this.startAttempt({
        runId: attempt.runId,
        assignmentId: attempt.assignmentId,
        callID: attempt.callID,
        tool: attempt.tool,
        actionFingerprint: attempt.actionFingerprint,
        preStateFingerprint: attempt.preStateFingerprint,
        startedAt: attempt.startedAt,
      });
    }

    const full: AttemptRecord = {
      runId: attempt.runId,
      assignmentId: attempt.assignmentId,
      attemptNumber: attempt.attemptNumber,
      callID: attempt.callID,
      tool: attempt.tool,
      actionFingerprint: attempt.actionFingerprint,
      preStateFingerprint: attempt.preStateFingerprint,
      startedAt: attempt.startedAt ?? new Date().toISOString(),
      progressProduced: false,
      repositoryDelta: 0,
      evidenceDelta: 0,
      verificationDelta: 0,
      childStateDelta: 0,
      evidenceIds: [],
    };
    this.recordAttempt(full);
    return full;
  }

  /**
   * Finalize attempt state at tool.execute.after.
   */
  finalizeAttempt(input: {
    runId: string;
    assignmentId: string;
    attemptNumber: number;
    resultFingerprint?: string;
    postStateFingerprint?: string;
    finishedAt?: string;
    progressProduced: boolean;
    repositoryDelta?: number;
    evidenceDelta?: number;
    verificationDelta?: number;
    childStateDelta?: number;
    isTransientError?: boolean;
    failureReason?: string;
    evidenceIds?: string[];
  }): AttemptRecord | null {
    const attempts = this.listAttempts(input.runId, input.assignmentId);
    const existing = attempts.find(a => a.attemptNumber === input.attemptNumber);
    if (!existing) return null;

    const updated: AttemptRecord = {
      ...existing,
      resultFingerprint: input.resultFingerprint ?? existing.resultFingerprint,
      postStateFingerprint: input.postStateFingerprint ?? existing.postStateFingerprint,
      finishedAt: input.finishedAt ?? new Date().toISOString(),
      progressProduced: input.progressProduced,
      repositoryDelta: input.repositoryDelta ?? existing.repositoryDelta,
      evidenceDelta: input.evidenceDelta ?? existing.evidenceDelta,
      verificationDelta: input.verificationDelta ?? existing.verificationDelta,
      childStateDelta: input.childStateDelta ?? existing.childStateDelta,
      isTransientError: input.isTransientError ?? existing.isTransientError,
      failureReason: input.failureReason ?? existing.failureReason,
      evidenceIds: input.evidenceIds ?? existing.evidenceIds,
    };
    this.recordAttempt(updated);
    return updated;
  }

  /**
   * List all attempt history for a specific work item / Assignment / Root unit.
   */
  listAttempts(runId: string, assignmentId: string): AttemptRecord[] {
    const rows = this.db.query(
      "SELECT * FROM execution_metadata WHERE run_id = ? AND key LIKE ? ORDER BY created_at ASC"
    ).all(runId, `attempt:${runId}:${assignmentId}:%`) as Record<string, unknown>[];

    const results: AttemptRecord[] = [];
    for (const r of rows) {
      try {
        results.push(JSON.parse(r.value as string));
      } catch {}
    }
    return results;
  }

  /**
   * Durable state-scoped strategy constraint set management in execution_metadata.
   */
  saveStrategyConstraint(input: SaveStrategyConstraintInput | StrategyConstraint): void {
    const key = `strategy_constraint_set:${input.runId}:${input.assignmentId}`;
    const existing = this.getActiveStrategyConstraints(input.runId, input.assignmentId);
    const now = new Date().toISOString();

    let constraintSet: StrategyConstraintSet;

    if (existing && existing.stateFingerprint === input.stateFingerprint) {
      if (existing.exhausted) {
        constraintSet = {
          ...existing,
          updatedAt: now,
        };
      } else {
        const alreadyContains = existing.prohibitedActionFingerprints.includes(input.prohibitedActionFingerprint);
        if (alreadyContains) {
          constraintSet = {
            ...existing,
            updatedAt: now,
          };
        } else if (existing.prohibitedActionFingerprints.length >= 20) {
          // 21st unique strategy under same state -> mark exhausted, retain all 20 without evicting
          constraintSet = {
            ...existing,
            exhausted: true,
            updatedAt: now,
          };
        } else {
          // Accumulate unique failure (1..20)
          const prohibited = [...existing.prohibitedActionFingerprints, input.prohibitedActionFingerprint];
          const reasons = { ...existing.reasonsByFingerprint, [input.prohibitedActionFingerprint]: input.reason };
          constraintSet = {
            runId: input.runId,
            assignmentId: input.assignmentId,
            stateFingerprint: input.stateFingerprint,
            prohibitedActionFingerprints: prohibited,
            reasonsByFingerprint: reasons,
            exhausted: false,
            createdAt: existing.createdAt,
            updatedAt: now,
          };
        }
      }
    } else {
      // State changed or first constraint: supersede with fresh set for this state
      constraintSet = {
        runId: input.runId,
        assignmentId: input.assignmentId,
        stateFingerprint: input.stateFingerprint,
        prohibitedActionFingerprints: [input.prohibitedActionFingerprint],
        reasonsByFingerprint: { [input.prohibitedActionFingerprint]: input.reason },
        exhausted: false,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      };
    }

    const val = JSON.stringify(constraintSet);
    this.db.query(
      `INSERT INTO execution_metadata (id, run_id, session_id, key, value, created_at)
       VALUES (?, ?, NULL, ?, ?, datetime('now'))
       ON CONFLICT(run_id, key) DO UPDATE SET value = excluded.value`
    ).run(
      `meta-scs-${input.runId}-${input.assignmentId}`,
      input.runId,
      key,
      val
    );
  }

  getActiveStrategyConstraints(runId: string, assignmentId: string): StrategyConstraintSet | null {
    const key = `strategy_constraint_set:${runId}:${assignmentId}`;
    const row = this.db.query(
      "SELECT value FROM execution_metadata WHERE run_id = ? AND key = ?"
    ).get(runId, key) as { value: string } | null;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as StrategyConstraintSet;
      if (parsed.clearedAt) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  getActiveStrategyConstraint(runId: string, assignmentId: string): StrategyConstraint | null {
    const set = this.getActiveStrategyConstraints(runId, assignmentId);
    if (!set || set.prohibitedActionFingerprints.length === 0) return null;
    const latestFp = set.prohibitedActionFingerprints[set.prohibitedActionFingerprints.length - 1];
    return {
      runId: set.runId,
      assignmentId: set.assignmentId,
      prohibitedActionFingerprint: latestFp,
      stateFingerprint: set.stateFingerprint,
      reason: set.reasonsByFingerprint?.[latestFp] ?? "REPEATED_ACTION_BLOCKED",
      createdAt: set.createdAt,
      clearedAt: set.clearedAt,
    };
  }

  clearStrategyConstraint(runId: string, assignmentId: string): void {
    const set = this.getActiveStrategyConstraints(runId, assignmentId);
    if (set) {
      set.clearedAt = new Date().toISOString();
      const key = `strategy_constraint_set:${runId}:${assignmentId}`;
      const val = JSON.stringify(set);
      this.db.query(
        `INSERT INTO execution_metadata (id, run_id, session_id, key, value, created_at)
         VALUES (?, ?, NULL, ?, ?, datetime('now'))
         ON CONFLICT(run_id, key) DO UPDATE SET value = excluded.value`
      ).run(
        `meta-scs-${runId}-${assignmentId}`,
        runId,
        key,
        val
      );
    }
  }

  computeStrategyStateFingerprint(
    runId: string,
    assignmentId: string,
    snapshot?: OrchestrationSnapshot | null
  ): string {
    const snap = snapshot ?? this.snapshotService.getSnapshot(runId);
    const meaningfulVersion = this.progressService.getMeaningfulStateVersion(runId);
    const activeRequired = snap?.childState?.activeRequired ?? 0;
    const failedRequired = snap?.childState?.failedRequired ?? 0;
    const satisfiedWorkItems = snap?.workItems?.filter((w: any) => w.isSatisfied).length ?? 0;

    return `${runId}:${assignmentId}:${meaningfulVersion}:${activeRequired}:${failedRequired}:${satisfiedWorkItems}`;
  }

  getConsumedProgressAttempt(runId: string, assignmentId: string): number | null {
    const key = `consumed_progress_attempt:${runId}:${assignmentId}`;
    const row = this.db.query(
      "SELECT value FROM execution_metadata WHERE run_id = ? AND key = ?"
    ).get(runId, key) as { value: string } | null;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value);
      return typeof parsed === "number" ? parsed : (parsed.attemptNumber ?? null);
    } catch {
      return null;
    }
  }

  markConsumedProgressAttempt(runId: string, assignmentId: string, attemptNumber: number): void {
    const key = `consumed_progress_attempt:${runId}:${assignmentId}`;
    const val = JSON.stringify({ attemptNumber, consumedAt: new Date().toISOString() });
    this.db.query(
      `INSERT INTO execution_metadata (id, run_id, session_id, key, value, created_at)
       VALUES (?, ?, NULL, ?, ?, datetime('now'))
       ON CONFLICT(run_id, key) DO UPDATE SET value = excluded.value`
    ).run(
      `meta-cpa-${runId}-${assignmentId}`,
      runId,
      key,
      val
    );
  }

  /**
   * Deterministic check for transient errors.
   */
  isTransientError(error?: string | Error | null): boolean {
    if (!error) return false;
    const msg = typeof error === "string" ? error : error.message;
    const lower = msg.toLowerCase();
    return (
      lower.includes("timeout") ||
      lower.includes("econnrefused") ||
      lower.includes("etimedout") ||
      lower.includes("rate limit") ||
      lower.includes("429") ||
      lower.includes("503") ||
      lower.includes("temporary") ||
      lower.includes("transient") ||
      lower.includes("socket hang up")
    );
  }

  /**
   * Perform mandatory CAS phase transition.
   */
  transitionPhase(input: TransitionPhaseCasInput): boolean {
    const { runId, targetPhase, expectedPhase, expectedAggregateVersion, completionPolicy } = input;

    // 1. Invariant: terminal phases are immutable
    if (TERMINAL_PHASES.has(expectedPhase)) {
      console.warn(
        `[RunTransitionEngine] Phase transition rejected: run ${runId} is terminal in '${expectedPhase}', cannot transition to '${targetPhase}'.`
      );
      return false;
    }

    // 2. Invariant: only the single policy instance bound by composition may
    // request completion.  A string marker is forgeable by every caller and is
    // therefore insufficient as a completion authority boundary.
    if (targetPhase === OP.COMPLETED && (
      !this.completionPolicyAuthority || completionPolicy !== this.completionPolicyAuthority
    )) {
      console.warn("[RunTransitionEngine] Phase transition rejected: transition to 'completed' requires the bound CompletionPolicy capability.");
      return false;
    }

    // 3. Central transition table validation
    if (!isValidPhaseTransition(expectedPhase, targetPhase)) {
      console.warn(
        `[RunTransitionEngine] Invalid phase transition rejected: run ${runId} from '${expectedPhase}' to '${targetPhase}'.`
      );
      return false;
    }

    // 4. Mandatory CAS update on task_runs table
    const result = this.taskRunRepo.transitionPhaseCas({
      runId,
      expectedPhase,
      targetPhase,
      expectedAggregateVersion,
      sha: input.sha,
    });

    return result.success;
  }

  /**
   * Evaluate runtime state and compute next deterministic transition decision.
   */
  evaluate(input: {
    runId: string;
    sessionId?: string;
    latestActionFingerprint?: string;
    latestTool?: string;
    latestError?: string;
    isVerification?: boolean;
  }): TransitionEvaluationResult {
    const snapshot = this.snapshotService.getSnapshot(input.runId, input.sessionId);
    if (!snapshot) {
      return {
        runId: input.runId,
        currentPhase: OP.FAILED,
        phaseChanged: false,
        workItemChanged: false,
        strategyDecision: "BLOCK",
        reasonCode: "BLOCKED",
        requiresAction: false,
        blockerReason: "Run not found",
      };
    }

    const currentPhase = snapshot.phase;

    // 1. Terminal invariant: no transitions from terminal phases
    if (TERMINAL_PHASES.has(currentPhase)) {
      return {
        runId: input.runId,
        currentPhase,
        phaseChanged: false,
        workItemChanged: false,
        strategyDecision: "BLOCK",
        reasonCode: currentPhase === OP.CANCELLED ? "USER_CANCELLED" : "ALL_WORK_ITEMS_COMPLETE",
        requiresAction: false,
      };
    }

    const workItems = snapshot.workItems;
    const currentWorkItem = workItems.find(w => w.id === snapshot.currentWorkItemId);

    // 2. Explicit Failed Child / Assignment Recovery (Required-aware)
    const failedWorkItems = workItems.filter(w => w.status === "failed" && w.isRequired);
    const failedRequiredChildren = snapshot.childState.failedRequired;

    if (failedWorkItems.length > 0 || failedRequiredChildren > 0) {
      let targetPhase = currentPhase;
      let phaseChanged = false;
      if (currentPhase === OP.EXECUTING || currentPhase === OP.DELEGATING) {
        if (isValidPhaseTransition(currentPhase, OP.RECOVERING)) {
          const transitioned = this.transitionPhase({
            runId: input.runId,
            targetPhase: OP.RECOVERING,
            expectedPhase: currentPhase,
            expectedAggregateVersion: snapshot.aggregateVersion,
            authority: "transition_engine",
          });
          if (transitioned) {
            targetPhase = OP.RECOVERING;
            phaseChanged = true;
          } else {
            return {
              runId: input.runId,
              currentPhase,
              phaseChanged: false,
              currentWorkItemId: currentWorkItem?.id,
              workItemChanged: false,
              strategyDecision: "BLOCK",
              reasonCode: "TRANSITION_CONFLICT",
              requiresAction: false,
              blockerReason: "CAS transition conflict entering RECOVERING",
            };
          }
        }
      }

      return {
        runId: input.runId,
        currentPhase: targetPhase,
        phaseChanged,
        currentWorkItemId: currentWorkItem?.id,
        workItemChanged: false,
        strategyDecision: "CHANGE_STRATEGY",
        reasonCode: failedRequiredChildren > 0 ? "CHILD_FAILED" : "ASSIGNMENT_FAILED",
        requiresAction: true,
      };
    }

    // Resolve target item: current work item, or first work item, or canonical root execution unit
    const rootExecutionId = "root:" + input.runId;
    const targetItemId = currentWorkItem?.id ?? workItems[0]?.id ?? rootExecutionId;
    const attempts = this.listAttempts(input.runId, targetItemId);
    const lastAttempt = attempts[attempts.length - 1];

    // Check strategy exhaustion for this target item under current meaningful state fingerprint
    const activeConstraint = this.getActiveStrategyConstraints(input.runId, targetItemId);
    const strategyFp = this.computeStrategyStateFingerprint(input.runId, targetItemId, snapshot);
    if (activeConstraint?.exhausted === true && activeConstraint.stateFingerprint === strategyFp) {
      return {
        runId: input.runId,
        currentPhase,
        phaseChanged: false,
        currentWorkItemId: targetItemId,
        workItemChanged: false,
        strategyDecision: "BLOCK",
        reasonCode: "STRATEGY_SET_EXHAUSTED",
        requiresAction: false,
        blockerReason: "Strategy search exhausted under unchanged meaningful state",
      };
    }

    // 3. Check Stall condition from AdaptiveExecutionControl
    if (snapshot.progress.stalled) {
      let targetPhase = currentPhase;
      let phaseChanged = false;
      if (currentPhase !== OP.RECOVERING && isValidPhaseTransition(currentPhase, OP.RECOVERING)) {
        const transitioned = this.transitionPhase({
          runId: input.runId,
          targetPhase: OP.RECOVERING,
          expectedPhase: currentPhase,
          expectedAggregateVersion: snapshot.aggregateVersion,
          authority: "transition_engine",
        });
        if (transitioned) {
          targetPhase = OP.RECOVERING;
          phaseChanged = true;
        } else {
          return {
            runId: input.runId,
            currentPhase,
            phaseChanged: false,
            currentWorkItemId: currentWorkItem?.id,
            workItemChanged: false,
            strategyDecision: "BLOCK",
            reasonCode: "TRANSITION_CONFLICT",
            requiresAction: false,
            blockerReason: "CAS transition conflict entering RECOVERING on stall",
          };
        }
      }

      const stalledActionFingerprint =
        input.latestActionFingerprint ?? lastAttempt?.actionFingerprint;

      if (stalledActionFingerprint) {
        const causalFp = (lastAttempt && lastAttempt.preStateFingerprint)
          ? lastAttempt.preStateFingerprint
          : this.computeStrategyStateFingerprint(input.runId, targetItemId, snapshot);
        this.saveStrategyConstraint({
          runId: input.runId,
          assignmentId: targetItemId,
          prohibitedActionFingerprint: stalledActionFingerprint,
          stateFingerprint: causalFp,
          reason: "STALL_DETECTED",
          createdAt: new Date().toISOString(),
        });
      }

      return {
        runId: input.runId,
        currentPhase: targetPhase,
        phaseChanged,
        currentWorkItemId: currentWorkItem?.id,
        workItemChanged: false,
        strategyDecision: "CHANGE_STRATEGY",
        reasonCode: "STALL_DETECTED",
        requiresAction: true,
        prohibitedActionFingerprint: stalledActionFingerprint,
      };
    }

    // 4. Action Repetition & Progress Check on latest attempt / state delta
    const hasRepositoryStateChange = snapshot.progress.lastRepositoryDelta > 0;
    const hasAttemptProgress = lastAttempt ? lastAttempt.progressProduced : false;
    const hasStateChange = hasRepositoryStateChange || hasAttemptProgress;

    // If in recovering and progress was produced, transition back to executing
    if (currentPhase === OP.RECOVERING && hasStateChange) {
      const transitioned = this.transitionPhase({
        runId: input.runId,
        targetPhase: OP.EXECUTING,
        expectedPhase: currentPhase,
        expectedAggregateVersion: snapshot.aggregateVersion,
        authority: "transition_engine",
      });
      if (transitioned) {
        this.clearStrategyConstraint(input.runId, targetItemId);
        return {
          runId: input.runId,
          currentPhase: OP.EXECUTING,
          phaseChanged: true,
          currentWorkItemId: targetItemId,
          workItemChanged: false,
          strategyDecision: "EXECUTE_CURRENT",
          reasonCode: "RECOVERY_PROGRESS",
          requiresAction: true,
        };
      } else {
        return {
          runId: input.runId,
          currentPhase,
          phaseChanged: false,
          currentWorkItemId: targetItemId,
          workItemChanged: false,
          strategyDecision: "BLOCK",
          reasonCode: "TRANSITION_CONFLICT",
          requiresAction: false,
          blockerReason: "CAS transition conflict exiting RECOVERING",
        };
      }
    }

    const actionFingerprint = input.latestActionFingerprint ?? lastAttempt?.actionFingerprint;

    if (actionFingerprint && lastAttempt) {
      // Causal repeat check
      if (lastAttempt.actionFingerprint === actionFingerprint && !lastAttempt.progressProduced && !hasStateChange) {
        // Count consecutive transient attempts of this exact action lineage
        const matchingLineage = attempts.filter(a => a.actionFingerprint === actionFingerprint);
        const transientCount = matchingLineage.filter(a => a.isTransientError).length;
        const isCurrentTransient = (input.latestError && this.isTransientError(input.latestError)) || lastAttempt.isTransientError;

        if (isCurrentTransient && transientCount <= 2) {
          return {
            runId: input.runId,
            currentPhase,
            phaseChanged: false,
            currentWorkItemId: targetItemId,
            workItemChanged: false,
            strategyDecision: "RETRY_SAME_STRATEGY",
            reasonCode: "TRANSIENT_RETRY_ALLOWED",
            requiresAction: true,
          };
        }

        // Prohibit immediate unchanged strategy repetition and persist StrategyConstraint
        const causalFp = lastAttempt.preStateFingerprint ?? this.computeStrategyStateFingerprint(input.runId, targetItemId, snapshot);
        this.saveStrategyConstraint({
          runId: input.runId,
          assignmentId: targetItemId,
          prohibitedActionFingerprint: actionFingerprint,
          stateFingerprint: causalFp,
          reason: "REPEATED_ACTION_BLOCKED",
          createdAt: new Date().toISOString(),
        });

        return {
          runId: input.runId,
          currentPhase: currentPhase === OP.RECOVERING ? currentPhase : OP.EXECUTING,
          phaseChanged: false,
          currentWorkItemId: targetItemId,
          workItemChanged: false,
          strategyDecision: "CHANGE_STRATEGY",
          reasonCode: "REPEATED_ACTION_BLOCKED",
          requiresAction: true,
          prohibitedActionFingerprint: actionFingerprint,
        };
      }

      if (lastAttempt.progressProduced || hasRepositoryStateChange) {
        // Check if this attempt progress was already consumed to prevent infinite PROGRESS_CONFIRMED loops
        const consumedNum = this.getConsumedProgressAttempt(input.runId, targetItemId);
        if (consumedNum === lastAttempt.attemptNumber) {
          return {
            runId: input.runId,
            currentPhase,
            phaseChanged: false,
            currentWorkItemId: targetItemId,
            workItemChanged: false,
            strategyDecision: "EXECUTE_CURRENT",
            reasonCode: "NO_PROGRESS",
            requiresAction: false,
          };
        }

        this.markConsumedProgressAttempt(input.runId, targetItemId, lastAttempt.attemptNumber);

        // Clear any previous strategy constraint on this work item when progress is produced
        this.clearStrategyConstraint(input.runId, targetItemId);

        return {
          runId: input.runId,
          currentPhase,
          phaseChanged: false,
          currentWorkItemId: targetItemId,
          workItemChanged: false,
          strategyDecision: "EXECUTE_CURRENT",
          reasonCode: "PROGRESS_CONFIRMED",
          requiresAction: true,
        };
      }
    }

    // 5. Verification cannot start while cancellation or deferred replacement has not
    // durably settled, regardless of a session.idle trigger.
    if (snapshot.lifecycleBlocks.cancellationPending || snapshot.lifecycleBlocks.unresolvedDeferredReplacement) {
      return {
        runId: input.runId,
        currentPhase,
        phaseChanged: false,
        currentWorkItemId: currentWorkItem?.id,
        workItemChanged: false,
        strategyDecision: "BLOCK",
        reasonCode: "BLOCKED",
        requiresAction: false,
        blockerReason: snapshot.lifecycleBlocks.cancellationPending
          ? "Cancellation barrier remains unresolved"
          : "Deferred replacement barrier remains unresolved",
      };
    }

    // 6. If child tasks are actively running in the background, must wait (Required-aware)
    const activeRequiredChildren = snapshot.childState.activeRequired;
    if (activeRequiredChildren > 0) {
      return {
        runId: input.runId,
        currentPhase,
        phaseChanged: false,
        currentWorkItemId: currentWorkItem?.id,
        workItemChanged: false,
        strategyDecision: "EXECUTE_CURRENT",
        reasonCode: "WAITING_FOR_CHILDREN",
        requiresAction: false,
      };
    }

    // 7. Check if all required work items are satisfied
    const requiredWorkItems = workItems.filter(w => w.isRequired);
    const allRequiredSatisfied = requiredWorkItems.length > 0 && requiredWorkItems.every(w => w.isSatisfied);

    if (allRequiredSatisfied && activeRequiredChildren === 0 && failedRequiredChildren === 0) {
      let targetPhase = currentPhase;
      let phaseChanged = false;
      if (currentPhase !== OP.VERIFYING && isValidPhaseTransition(currentPhase, OP.VERIFYING)) {
        const transitioned = this.transitionPhase({
          runId: input.runId,
          targetPhase: OP.VERIFYING,
          expectedPhase: currentPhase,
          expectedAggregateVersion: snapshot.aggregateVersion,
          authority: "transition_engine",
        });
        if (transitioned) {
          targetPhase = OP.VERIFYING;
          phaseChanged = true;
        } else {
          return {
            runId: input.runId,
            currentPhase,
            phaseChanged: false,
            workItemChanged: false,
            strategyDecision: "BLOCK",
            reasonCode: "TRANSITION_CONFLICT",
            requiresAction: false,
            blockerReason: "CAS transition conflict entering VERIFYING",
          };
        }
      }

      return {
        runId: input.runId,
        currentPhase: targetPhase,
        phaseChanged,
        workItemChanged: false,
        strategyDecision: "EXECUTE_CURRENT",
        reasonCode: "READY_FOR_VERIFICATION",
        requiresAction: true,
      };
    }

    // 8. Check if next work item is ready
    if (currentWorkItem && currentWorkItem.status === "pending") {
      return {
        runId: input.runId,
        currentPhase,
        phaseChanged: false,
        currentWorkItemId: currentWorkItem.id,
        workItemChanged: false,
        strategyDecision: "EXECUTE_CURRENT",
        reasonCode: "NEXT_WORK_ITEM_READY",
        requiresAction: true,
      };
    }

    // 9. Conservative fallback: no authoritative delta -> NO_PROGRESS, no autonomous continuation
    return {
      runId: input.runId,
      currentPhase,
      phaseChanged: false,
      currentWorkItemId: currentWorkItem?.id,
      workItemChanged: false,
      strategyDecision: "EXECUTE_CURRENT",
      reasonCode: "NO_PROGRESS",
      requiresAction: false,
    };
  }

  /**
   * Applies only a durable result that still names the current authoritative Run state.
   * A pass remains non-terminal: CompletionPolicy is the sole future authority for
   * completed. A failure returns the Run to existing recovery semantics.
   */
  observeVerificationResult(input: {
    runId: string;
    stateVersion: number;
    stateFingerprint: string;
    status: "passed" | "failed";
  }): TransitionEvaluationResult {
    const snapshot = this.snapshotService.getSnapshot(input.runId);
    if (!snapshot || TERMINAL_PHASES.has(snapshot.phase)) {
      return {
        runId: input.runId,
        currentPhase: snapshot?.phase ?? OP.FAILED,
        phaseChanged: false,
        workItemChanged: false,
        strategyDecision: "BLOCK",
        reasonCode: "BLOCKED",
        requiresAction: false,
        blockerReason: "Run is absent or terminal before verification result application",
      };
    }

    const currentFingerprint = this.snapshotService.computeStateFingerprint(input.runId);
    if (
      snapshot.phase !== OP.VERIFYING ||
      snapshot.aggregateVersion !== input.stateVersion ||
      currentFingerprint !== input.stateFingerprint
    ) {
      return {
        runId: input.runId,
        currentPhase: snapshot.phase,
        phaseChanged: false,
        workItemChanged: false,
        strategyDecision: "BLOCK",
        reasonCode: "VERIFICATION_STALE",
        requiresAction: false,
        blockerReason: "Verification result does not match the current authoritative Run state",
      };
    }

    if (input.status === "passed") {
      return {
        runId: input.runId,
        currentPhase: OP.VERIFYING,
        phaseChanged: false,
        workItemChanged: false,
        strategyDecision: "EXECUTE_CURRENT",
        reasonCode: "VERIFICATION_PASSED",
        requiresAction: false,
      };
    }

    const transitioned = this.transitionPhase({
      runId: input.runId,
      targetPhase: OP.RECOVERING,
      expectedPhase: OP.VERIFYING,
      expectedAggregateVersion: snapshot.aggregateVersion,
      authority: "transition_engine",
    });
    return {
      runId: input.runId,
      currentPhase: transitioned ? OP.RECOVERING : OP.VERIFYING,
      targetPhase: transitioned ? OP.RECOVERING : undefined,
      phaseChanged: transitioned,
      workItemChanged: false,
      strategyDecision: transitioned ? "CHANGE_STRATEGY" : "BLOCK",
      reasonCode: transitioned ? "VERIFICATION_FAILED" : "TRANSITION_CONFLICT",
      requiresAction: transitioned,
      blockerReason: transitioned ? undefined : "CAS transition conflict applying verification failure",
    };
  }
}
