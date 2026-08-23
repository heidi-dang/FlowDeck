/**
 * RunTransitionEngine — Authoritative deterministic transition engine for FlowDeck runs.
 *
 * Enforces:
 * - Legal Run phase transitions via central transition table.
 * - Terminal state immutability (completed, failed, cancelled).
 * - Progress-driven work-item / Assignment advancement.
 * - Durable attempt accounting and action repetition prevention.
 * - ChangeStrategy / Retry classification (transient retry vs change-strategy vs replan vs block).
 * - Parallel child convergence and recovery handling.
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
  actionFingerprint: string;
  resultFingerprint: string;
  tool: string;
  startedAt: string;
  finishedAt: string;
  progressProduced: boolean;
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
   * Transition the durable task_runs state atomically with validation against the transition table.
   */
  transitionPhase(runId: string, targetPhase: OrchestrationPhase): boolean {
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

    if (!isValidPhaseTransition(currentPhase, targetPhase)) {
      console.warn(
        `[RunTransitionEngine] Invalid phase transition rejected: run ${runId} from '${currentPhase}' to '${targetPhase}'.`
      );
      return false;
    }

    return this.taskRunRepo.updateState(runId, targetPhase);
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

    // Terminal invariant: no transitions from terminal phases
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

    // 1. Check Stall condition from AdaptiveExecutionControl
    if (snapshot.progress.stalled) {
      if (currentPhase === OP.CREATED || currentPhase === OP.PLANNING) {
        this.transitionPhase(input.runId, OP.EXECUTING);
        currentPhase = OP.EXECUTING;
      }

      let targetPhase = currentPhase;
      let phaseChanged = false;
      if (currentPhase !== OP.RECOVERING) {
        if (isValidPhaseTransition(currentPhase, OP.RECOVERING)) {
          this.transitionPhase(input.runId, OP.RECOVERING);
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

    // 2. Action Repetition & Progress Check for the current work item
    if (input.latestActionFingerprint) {
      const targetItemId = currentWorkItem?.id ?? workItems[0]?.id;
      const attempts = targetItemId ? this.listAttempts(input.runId, targetItemId) : [];
      const lastAttempt = attempts[attempts.length - 1];

      const hasStateChange =
        snapshot.progress.lastRepositoryDelta > 0 ||
        snapshot.progress.lastEvidenceDelta > 0;

      // Check if identical action is being repeated without state change
      if (lastAttempt && lastAttempt.actionFingerprint === input.latestActionFingerprint && !hasStateChange) {
        // Check if transient error retry is allowed
        if (input.latestError && this.isTransientError(input.latestError) && attempts.length <= 2) {
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
          prohibitedActionFingerprint: input.latestActionFingerprint,
        };
      }

      // If action is evaluated after state change or recovery progress
      if (currentPhase === OP.RECOVERING && hasStateChange) {
        this.transitionPhase(input.runId, OP.EXECUTING);
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

      if (hasStateChange) {
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

    // 3. If child tasks are actively running in the background, must wait
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

    // 4. Check if all work items are completed
    const activeWorkItems = workItems.filter(w => w.status === "in_progress" || (w.status as string) === "running" || w.status === "assigned");
    const pendingWorkItems = workItems.filter(w => w.status === "pending");
    const failedWorkItems = workItems.filter(w => w.status === "failed");

    if (workItems.length > 0 && activeWorkItems.length === 0 && pendingWorkItems.length === 0 && failedWorkItems.length === 0) {
      // If run was in created/planning, transition through executing to verifying
      if (currentPhase === OP.CREATED || currentPhase === OP.PLANNING) {
        this.transitionPhase(input.runId, OP.EXECUTING);
        currentPhase = OP.EXECUTING;
      }

      // All implementation work items completed -> transition to VERIFYING (not COMPLETED yet)
      let targetPhase = currentPhase;
      let phaseChanged = false;
      if (currentPhase !== OP.VERIFYING) {
        if (isValidPhaseTransition(currentPhase, OP.VERIFYING)) {
          this.transitionPhase(input.runId, OP.VERIFYING);
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

    // 5. If currently in RECOVERING and positive progress occurred, transition back to EXECUTING
    if (currentPhase === OP.RECOVERING && (snapshot.progress.lastRepositoryDelta > 0 || snapshot.progress.lastEvidenceDelta > 0)) {
      this.transitionPhase(input.runId, OP.EXECUTING);
      return {
        runId: input.runId,
        currentPhase: OP.EXECUTING,
        phaseChanged: true,
        currentWorkItemId: currentWorkItem?.id,
        workItemChanged: false,
        strategyDecision: "EXECUTE_CURRENT",
        reasonCode: "RECOVERY_PROGRESS",
        requiresAction: true,
      };
    }

    // 6. Default active execution progression
    return {
      runId: input.runId,
      currentPhase,
      phaseChanged: false,
      currentWorkItemId: currentWorkItem?.id,
      workItemChanged: false,
      strategyDecision: "EXECUTE_CURRENT",
      reasonCode: "PROGRESS_CONFIRMED",
      requiresAction: true,
    };
  }
}
