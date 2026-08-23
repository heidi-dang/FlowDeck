/**
 * RunTransitionEngine — Authoritative deterministic transition engine for FlowDeck runs.
 *
 * Enforces:
 * - Legal Run phase transitions via central transition table and CAS with aggregate versioning.
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
  | "BLOCKED";

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
   * Transition the durable task_runs state atomically with validation against the transition table and CAS.
   */
  transitionPhase(input: {
    runId: string;
    targetPhase: OrchestrationPhase;
    expectedPhase?: OrchestrationPhase;
    expectedAggregateVersion?: number;
    authority?: "transition_engine" | "completion_policy" | "run_service";
    sha?: string;
  } | string, targetPhaseArg?: OrchestrationPhase): boolean {
    const runId = typeof input === "string" ? input : input.runId;
    const targetPhase = typeof input === "string" ? (targetPhaseArg as OrchestrationPhase) : input.targetPhase;
    const expectedPhase = typeof input === "object" ? input.expectedPhase : undefined;
    const expectedAggregateVersion = typeof input === "object" ? input.expectedAggregateVersion : undefined;
    const authority = typeof input === "object" ? input.authority : "transition_engine";
    const sha = typeof input === "object" ? input.sha : undefined;

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
        `[RunTransitionEngine] Phase transition rejected: transition to 'completed' requires authority 'completion_policy', received '${authority ?? "unauthorized"}'.`
      );
      return false;
    }

    if (!isValidPhaseTransition(currentPhase, targetPhase)) {
      console.warn(
        `[RunTransitionEngine] Invalid phase transition rejected: run ${runId} from '${currentPhase}' to '${targetPhase}'.`
      );
      return false;
    }

    if (expectedAggregateVersion !== undefined) {
      const cas = this.taskRunRepo.transitionPhaseCas({
        runId,
        expectedPhase: expectedPhase ?? currentPhase,
        expectedAggregateVersion,
        targetPhase,
        sha,
      });
      return cas.success;
    }

    return this.taskRunRepo.updateState(runId, targetPhase, sha);
  }

  /**
   * Authoritative deterministic transition evaluation.
   * Answers: "What state is this Run in, what work item is current, did previous action advance it, and what is the legal next transition?"
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

    let currentPhase = snapshot.phase;

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
    let currentWorkItem = workItems.find(w => w.id === snapshot.currentWorkItemId);

    // 2. Explicit Failed Child / Assignment Recovery
    const failedWorkItems = workItems.filter(w => w.status === "failed" && w.isRequired);
    const failedChildren = snapshot.childState.failed;

    if (failedWorkItems.length > 0 || failedChildren > 0) {
      let targetPhase = currentPhase;
      let phaseChanged = false;
      if (currentPhase === OP.EXECUTING || currentPhase === OP.DELEGATING) {
        if (isValidPhaseTransition(currentPhase, OP.RECOVERING)) {
          this.transitionPhase({
            runId: input.runId,
            targetPhase: OP.RECOVERING,
            expectedPhase: currentPhase,
            expectedAggregateVersion: snapshot.aggregateVersion,
            authority: "transition_engine",
          });
          targetPhase = OP.RECOVERING;
          phaseChanged = true;
        }
      }

      return {
        runId: input.runId,
        currentPhase: targetPhase,
        phaseChanged,
        currentWorkItemId: currentWorkItem?.id,
        workItemChanged: false,
        strategyDecision: "CHANGE_STRATEGY",
        reasonCode: failedChildren > 0 ? "CHILD_FAILED" : "ASSIGNMENT_FAILED",
        requiresAction: true,
      };
    }

    // 3. Check Stall condition from AdaptiveExecutionControl
    if (snapshot.progress.stalled) {
      if (currentPhase === OP.CREATED || currentPhase === OP.PLANNING) {
        this.transitionPhase({
          runId: input.runId,
          targetPhase: OP.EXECUTING,
          authority: "transition_engine",
        });
        currentPhase = OP.EXECUTING;
      }

      let targetPhase = currentPhase;
      let phaseChanged = false;
      if (currentPhase !== OP.RECOVERING) {
        if (isValidPhaseTransition(currentPhase, OP.RECOVERING)) {
          this.transitionPhase({
            runId: input.runId,
            targetPhase: OP.RECOVERING,
            expectedPhase: currentPhase,
            expectedAggregateVersion: snapshot.aggregateVersion,
            authority: "transition_engine",
          });
          targetPhase = OP.RECOVERING;
          phaseChanged = true;
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
      this.transitionPhase({
        runId: input.runId,
        targetPhase: OP.EXECUTING,
        authority: "transition_engine",
      });
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

    // 5. If child tasks are actively running in the background, must wait
    const activeChildren = snapshot.childState.active;
    if (activeChildren > 0) {
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

    if (allRequiredSatisfied && activeChildren === 0 && failedChildren === 0) {
      // If run was in created/planning, transition through executing to verifying
      if (currentPhase === OP.CREATED || currentPhase === OP.PLANNING) {
        this.transitionPhase({
          runId: input.runId,
          targetPhase: OP.EXECUTING,
          authority: "transition_engine",
        });
        currentPhase = OP.EXECUTING;
      }

      // Transition to VERIFYING (not COMPLETED yet)
      let targetPhase = currentPhase;
      let phaseChanged = false;
      if (currentPhase !== OP.VERIFYING) {
        if (isValidPhaseTransition(currentPhase, OP.VERIFYING)) {
          this.transitionPhase({
            runId: input.runId,
            targetPhase: OP.VERIFYING,
            authority: "transition_engine",
          });
          targetPhase = OP.VERIFYING;
          phaseChanged = true;
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
