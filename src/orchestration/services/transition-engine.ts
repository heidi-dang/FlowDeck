/**
 * RunTransitionEngine — Authoritative deterministic transition engine for FlowDeck runs.
 *
 * Enforces:
 * - Legal Run phase transitions via central transition table and mandatory CAS with aggregate versioning.
 * - Terminal state immutability (completed, failed, cancelled) with exclusive CompletionPolicy authority for completed.
 * - Progress-driven work-item / Assignment advancement.
 * - Durable attempt accounting and action repetition prevention with causal state linkage.
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
import type { OrchestrationSnapshotService } from "./orchestration-snapshot-service";
import type { SqliteNativeChildExecutionRepository } from "../persistence/repositories/native-child-execution";
import type { TransactionManager } from "../persistence/transaction-manager";

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
  | "ALL_WORK_ITEMS_COMPLETE"
  | "WAITING_FOR_CHILDREN"
  | "USER_CANCELLED"
  | "SUPERSEDED"
  | "BLOCKED"
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
  authority?: "transition_engine" | "completion_policy" | "run_service";
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
  ) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.query(`
      CREATE TABLE IF NOT EXISTS call_id_attempts (
        call_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `).run();
  }

  /**
   * Allocate the next atomic attempt number for a work item / Assignment.
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
   * List all attempt history for a specific work item / Assignment.
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
   * Check if a specific error represents a transient condition eligible for same-strategy retry.
   */
  isTransientError(error?: string): boolean {
    if (!error) return false;
    const lower = error.toLowerCase();
    return (
      lower.includes("timeout") ||
      lower.includes("timed out") ||
      lower.includes("econnreset") ||
      lower.includes("econnrefused") ||
      lower.includes("rate limit") ||
      lower.includes("429") ||
      lower.includes("503") ||
      lower.includes("temporarily unavailable") ||
      lower.includes("gateway timeout")
    );
  }

  /**
   * Transition the durable task_runs state atomically with validation against the transition table and mandatory CAS.
   */
  transitionPhase(input: TransitionPhaseCasInput): boolean {
    const runId = input.runId;
    const targetPhase = input.targetPhase;
    const expectedPhase = input.expectedPhase;
    const expectedAggregateVersion = input.expectedAggregateVersion;
    const authority = input.authority ?? "transition_engine";
    const sha = input.sha;

    const taskRun = this.taskRunRepo.findById(runId);
    if (!taskRun) return false;

    const currentPhase = taskRun.state as OrchestrationPhase;
    if (currentPhase === targetPhase) return false;

    if (TERMINAL_PHASES.has(currentPhase)) {
      console.warn(
        `[RunTransitionEngine] Phase transition rejected: run ${runId} is terminal in '${currentPhase}', cannot transition to '${targetPhase}'.`
      );
      return false;
    }

    // COMPLETED is reserved exclusively for CompletionPolicy
    if (targetPhase === OP.COMPLETED && authority !== "completion_policy") {
      console.warn(
        `[RunTransitionEngine] Phase transition rejected: transition to 'completed' requires authority 'completion_policy', received '${authority}'.`
      );
      return false;
    }

    if (!isValidPhaseTransition(currentPhase, targetPhase)) {
      console.warn(
        `[RunTransitionEngine] Invalid phase transition rejected: run ${runId} from '${currentPhase}' to '${targetPhase}'.`
      );
      return false;
    }

    const cas = this.taskRunRepo.transitionPhaseCas({
      runId,
      expectedPhase: expectedPhase ?? currentPhase,
      expectedAggregateVersion,
      targetPhase,
      sha,
    });
    return cas.success;
  }

  /**
   * Authoritative deterministic transition evaluation.
   */
  evaluate(input: {
    runId: string;
    sessionId?: string;
    latestActionFingerprint?: string;
    latestResultFingerprint?: string;
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

      return {
        runId: input.runId,
        currentPhase: targetPhase,
        phaseChanged,
        currentWorkItemId: currentWorkItem?.id,
        workItemChanged: false,
        strategyDecision: "CHANGE_STRATEGY",
        reasonCode: "STALL_DETECTED",
        requiresAction: true,
        prohibitedActionFingerprint: input.latestActionFingerprint,
      };
    }

    // 4. Action Repetition & Progress Check on latest attempt / state delta
    const targetItemId = currentWorkItem?.id ?? workItems[0]?.id;
    const attempts = targetItemId ? this.listAttempts(input.runId, targetItemId) : [];
    const lastAttempt = attempts[attempts.length - 1];

    const hasStateChange =
      snapshot.progress.lastRepositoryDelta > 0 ||
      (lastAttempt ? lastAttempt.progressProduced : false);

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

        // Prohibit immediate unchanged strategy repetition
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

      if (lastAttempt.progressProduced || hasStateChange) {
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

    // 5. If child tasks are actively running in the background, must wait (Required-aware)
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

    // 6. Check if all required work items are satisfied
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

    // 7. Check if next work item is ready
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

    // 8. Conservative fallback: no authoritative delta -> NO_PROGRESS, no autonomous continuation
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
}
