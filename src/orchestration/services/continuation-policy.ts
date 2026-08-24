/**
 * ContinuationPolicy — Pure evaluation policy for autonomous continuation turns.
 *
 * Answers: "Should Heidi be asked to take another autonomous turn now?"
 *
 * Rules:
 * - Does NOT mutate state (RunTransitionEngine mutates state).
 * - Enforces positive allowlisted transition reason codes for CONTINUE_NOW.
 * - Idempotent, atomic dispatch via ContinuationDispatcher with durable SQLite state.
 * - Enforces continuation gates: Run active, matching user-turn version, matching aggregate version,
 *   no active background child, not blocked, not terminal.
 */

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { OrchestrationSnapshot } from "./orchestration-snapshot-service";
import type { TransitionEvaluationResult, TransitionReasonCode } from "./transition-engine";
import { TERMINAL_PHASES } from "./transition-engine";

export type ContinuationDecision =
  | "CONTINUE_NOW"
  | "WAIT_FOR_CHILD"
  | "WAIT_FOR_USER"
  | "REPLAN"
  | "STOP_TERMINAL"
  | "STOP_BLOCKED";

export interface ContinuationToken {
  runId: string;
  sessionId: string;
  userTurnVersion: number;
  runAggregateVersion: number;
  transitionReason: TransitionReasonCode;
  currentWorkItemId?: string;
  stateFingerprint: string;
  identityKey?: string;
}

export const CONTINUATION_ALLOWLIST: ReadonlySet<TransitionReasonCode> = new Set([
  "NEXT_WORK_ITEM_READY",
  "CHANGE_STRATEGY",
  "REPEATED_ACTION_BLOCKED",
  "TRANSIENT_RETRY_ALLOWED",
  "RECOVERY_PROGRESS",
  "STALL_DETECTED",
  "READY_FOR_VERIFICATION",
  "CHILD_FAILED",
  "ASSIGNMENT_FAILED",
  "PROGRESS_CONFIRMED",
] as TransitionReasonCode[]);

export function getContinuationPrompt(
  reason: TransitionReasonCode,
  details?: { prohibitedActionFingerprint?: string; blockerReason?: string }
): string {
  switch (reason) {
    case "NEXT_WORK_ITEM_READY":
      return "Continue with the next planned work item.";
    case "RECOVERY_PROGRESS":
      return "Recovery progress detected. Continue execution with the updated state.";
    case "READY_FOR_VERIFICATION":
      return "Work completed. Proceed to verify the results.";
    case "REPEATED_ACTION_BLOCKED": {
      const fp = details?.prohibitedActionFingerprint;
      return fp
        ? `Previous strategy produced no progress and action '${fp}' is prohibited under the current state. Change strategy, select a different tool or evidence source, or replan.`
        : "Previous strategy produced no progress. Change strategy, select a different tool or evidence source, or replan.";
    }
    case "STALL_DETECTED":
      return "Execution stall detected with no progress. Change strategy, try an alternate approach, or replan.";
    case "CHILD_FAILED":
      return "Child execution failed. Analyze the failure and select an alternate strategy or recovery step.";
    case "ASSIGNMENT_FAILED":
      return "Assignment failed. Analyze the failure and select an alternate strategy or recovery step.";
    case "TRANSIENT_RETRY_ALLOWED":
      return "Transient failure encountered. Retry the action.";
    case "PROGRESS_CONFIRMED":
      return "Progress confirmed. Continue with the next step.";
    default:
      return "Continue with the next planned step.";
  }
}

export interface EvaluateContinuationInput {
  snapshot: OrchestrationSnapshot;
  transition: TransitionEvaluationResult;
  hasActiveUserTurn?: boolean;
  isStaleEvent?: boolean;
}

export class ContinuationPolicy {
  /**
   * Pure evaluation of whether autonomous execution should continue.
   */
  evaluate(input: EvaluateContinuationInput): { decision: ContinuationDecision; reason: string } {
    const { snapshot, transition, hasActiveUserTurn, isStaleEvent } = input;

    // 1. Stale event or user interruption wins immediately
    if (isStaleEvent) {
      return { decision: "STOP_TERMINAL", reason: "Stale event ignored" };
    }

    if (hasActiveUserTurn) {
      return { decision: "WAIT_FOR_USER", reason: "User interruption in progress" };
    }

    // 2. Terminal Run states
    if (TERMINAL_PHASES.has(snapshot.phase) || snapshot.terminalState?.isTerminal) {
      return { decision: "STOP_TERMINAL", reason: `Run in terminal state: ${snapshot.phase}` };
    }

    // 3. Child tasks running -> must wait for native child results without injecting synthetic continuation
    if (snapshot.childState.activeRequired > 0 || transition.reasonCode === "WAITING_FOR_CHILDREN") {
      return { decision: "WAIT_FOR_CHILD", reason: "Active child executions in progress" };
    }

    // 4. Blocked conditions
    if (transition.strategyDecision === "BLOCK" || transition.reasonCode === "BLOCKED" || transition.reasonCode === "TRANSITION_CONFLICT") {
      return { decision: "STOP_BLOCKED", reason: transition.blockerReason ?? "Blocked on external condition" };
    }

    // 5. Replan required
    if (transition.strategyDecision === "REPLAN") {
      return { decision: "REPLAN", reason: "Transition requires replanning" };
    }

    // 6. Action required AND reason code is in the positive allowlist -> continue now
    if (transition.requiresAction && CONTINUATION_ALLOWLIST.has(transition.reasonCode)) {
      return { decision: "CONTINUE_NOW", reason: `Action required: ${transition.reasonCode}` };
    }

    return { decision: "WAIT_FOR_USER", reason: "No autonomous action pending" };
  }
}

export interface ContinuationStatePort {
  getUserTurnVersion(sessionId: string): number;
  getRunAggregateVersion(runId: string): number | null;
  getRunPhase?(runId: string): string | null;
  computeStateFingerprint?(runId: string, sessionId: string): string | null;
}

export type ContinuationDispatchResult = {
  dispatched: boolean;
  identity: string;
  reason?:
    | "native_dispatch_unavailable"
    | "native_dispatch_failed"
    | "duplicate_dispatch"
    | "dispatch_in_progress"
    | "dispatch_outcome_unknown"
    | "stale_user_turn_version"
    | "stale_run_aggregate_version"
    | "stale_state_fingerprint"
    | "run_not_found"
    | "authority_revoked";
};

export class ContinuationDispatcher {
  private readonly memoryDispatches = new Map<string, { status: "pending" | "dispatched" | "failed" | "blocked"; attemptCount: number }>();

  constructor(private readonly db?: Database) {}

  computeTokenIdentity(token: ContinuationToken): string {
    if (token.identityKey) {
      return createHash("sha256").update(token.identityKey).digest("hex");
    }
    const raw = `${token.runId}:${token.sessionId}:${token.userTurnVersion}:${token.runAggregateVersion}:${token.transitionReason}:${token.currentWorkItemId ?? ""}:${token.stateFingerprint}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  /**
   * Validate and dispatch exactly-once continuation with atomic reservation and durable SQLite tracking.
   */
  async dispatch(
    token: ContinuationToken,
    opts: {
      statePort?: ContinuationStatePort;
      currentTurnVersion?: number;
      currentAggregateVersion?: number;
      client?: any;
      promptText?: string;
      validateAuthority?: () => boolean | { valid: boolean; reason?: string };
    }
  ): Promise<ContinuationDispatchResult> {
    const identity = this.computeTokenIdentity(token);

    // 0. Explicit Authority Validation (e.g. for deferred replacements)
    if (opts.validateAuthority) {
      const authRes = opts.validateAuthority();
      const isValid = typeof authRes === "boolean" ? authRes : authRes.valid;
      if (!isValid) {
        return { dispatched: false, identity, reason: "authority_revoked" };
      }
    }

    // 1. Authoritative Revalidation against live state port (when validateAuthority is NOT used)
    if (opts.statePort && !opts.validateAuthority) {
      const currentTurn = opts.statePort.getUserTurnVersion(token.sessionId);
      if (currentTurn !== token.userTurnVersion) {
        return { dispatched: false, identity, reason: "stale_user_turn_version" };
      }

      const currentAgg = opts.statePort.getRunAggregateVersion(token.runId);
      if (currentAgg === null) {
        return { dispatched: false, identity, reason: "run_not_found" };
      }
      if (currentAgg !== token.runAggregateVersion) {
        return { dispatched: false, identity, reason: "stale_run_aggregate_version" };
      }

      if (opts.statePort.computeStateFingerprint) {
        const currentFp = opts.statePort.computeStateFingerprint(token.runId, token.sessionId);
        if (currentFp && currentFp !== token.stateFingerprint) {
          return { dispatched: false, identity, reason: "stale_state_fingerprint" };
        }
      }
    } else if (!opts.validateAuthority) {
      // Fallback version check if statePort omitted and no validateAuthority
      if (opts.currentTurnVersion !== undefined && token.userTurnVersion !== opts.currentTurnVersion) {
        return { dispatched: false, identity, reason: "stale_user_turn_version" };
      }
      if (opts.currentAggregateVersion !== undefined && token.runAggregateVersion !== opts.currentAggregateVersion) {
        return { dispatched: false, identity, reason: "stale_run_aggregate_version" };
      }
    }

    // 2. Atomic Continuation Claim
    const now = new Date().toISOString();
    const maxAttempts = 2;

    if (this.db) {
      const insertRes = this.db.query(`
        INSERT INTO continuation_dispatches (
          identity, run_id, session_id, user_turn_version, run_aggregate_version,
          transition_reason, current_work_item_id, state_fingerprint, status,
          attempt_count, created_at, last_attempt_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
        ON CONFLICT(identity) DO NOTHING
      `).run(
        identity,
        token.runId,
        token.sessionId,
        token.userTurnVersion,
        token.runAggregateVersion,
        token.transitionReason,
        token.currentWorkItemId ?? null,
        token.stateFingerprint,
        now,
        now
      );

      if (insertRes.changes === 0) {
        // Row already existed: inspect current status
        const existing = this.db.query(
          "SELECT status, attempt_count FROM continuation_dispatches WHERE identity = ?"
        ).get(identity) as { status: string; attempt_count: number } | null;

        if (!existing) {
          return { dispatched: false, identity, reason: "duplicate_dispatch" };
        }

        if (existing.status === "dispatched") {
          return { dispatched: false, identity, reason: "duplicate_dispatch" };
        }

        if (existing.status === "pending") {
          return { dispatched: false, identity, reason: "dispatch_in_progress" };
        }

        if (existing.status === "outcome_unknown") {
          return { dispatched: false, identity, reason: "dispatch_outcome_unknown" };
        }

        if (existing.status === "blocked") {
          return { dispatched: false, identity, reason: "native_dispatch_failed" };
        }

        if (existing.status === "failed") {
          if (existing.attempt_count >= maxAttempts) {
            this.db.query(
              "UPDATE continuation_dispatches SET status = 'blocked' WHERE identity = ? AND status = 'failed'"
            ).run(identity);
            return { dispatched: false, identity, reason: "native_dispatch_failed" };
          }

          // Atomic CAS failed -> pending with incremented attempt_count
          const casRes = this.db.query(`
            UPDATE continuation_dispatches
            SET status = 'pending', attempt_count = attempt_count + 1, last_attempt_at = ?, error = NULL
            WHERE identity = ? AND status = 'failed' AND attempt_count < ?
          `).run(now, identity, maxAttempts);

          if (casRes.changes === 0) {
            return { dispatched: false, identity, reason: "dispatch_in_progress" };
          }
          // Successfully acquired retry reservation!
        }
      }
    } else {
      // In-memory atomic claim fallback
      const existing = this.memoryDispatches.get(identity);
      if (existing) {
        if (existing.status === "dispatched") {
          return { dispatched: false, identity, reason: "duplicate_dispatch" };
        }
        if (existing.status === "pending") {
          return { dispatched: false, identity, reason: "dispatch_in_progress" };
        }
        if (existing.status === "outcome_unknown" as any) {
          return { dispatched: false, identity, reason: "dispatch_outcome_unknown" };
        }
        if (existing.status === "blocked") {
          return { dispatched: false, identity, reason: "native_dispatch_failed" };
        }
        if (existing.status === "failed") {
          if (existing.attemptCount >= maxAttempts) {
            existing.status = "blocked";
            return { dispatched: false, identity, reason: "native_dispatch_failed" };
          }
          existing.status = "pending";
          existing.attemptCount += 1;
        }
      } else {
        this.memoryDispatches.set(identity, { status: "pending", attemptCount: 1 });
      }
    }

    // 2.5 Re-verify authority before invoking native client
    if (opts.validateAuthority) {
      const authRes = opts.validateAuthority();
      const isValid = typeof authRes === "boolean" ? authRes : authRes.valid;
      if (!isValid) {
        if (this.db) {
          this.db.query(`
            UPDATE continuation_dispatches
            SET status = 'failed', error = 'authority_revoked'
            WHERE identity = ? AND status = 'pending'
          `).run(identity);
        }
        return { dispatched: false, identity, reason: "authority_revoked" };
      }
    }

    // 3. Check native promptAsync availability
    if (!opts.client?.session?.promptAsync) {
      if (this.db) {
        this.db.query(`
          UPDATE continuation_dispatches
          SET status = 'failed', error = 'native_dispatch_unavailable'
          WHERE identity = ?
        `).run(identity);
      } else {
        const mem = this.memoryDispatches.get(identity);
        if (mem) mem.status = "failed";
      }
      return { dispatched: false, identity, reason: "native_dispatch_unavailable" };
    }

    // 4. Invoke native OpenCode promptAsync
    try {
      const promptText = opts.promptText ?? getContinuationPrompt(token.transitionReason);
      const res = await opts.client.session.promptAsync({
        path: { id: token.sessionId },
        body: {
          parts: [{ type: "text", text: promptText }],
          agent: "heidi",
        },
      });

      if (res && res.error) {
        throw new Error(String(res.error));
      }

      // Mark dispatched on verified success
      const dispatchedAt = new Date().toISOString();
      if (this.db) {
        this.db.query(`
          UPDATE continuation_dispatches
          SET status = 'dispatched', dispatched_at = ?, error = NULL
          WHERE identity = ?
        `).run(dispatchedAt, identity);
      } else {
        const mem = this.memoryDispatches.get(identity);
        if (mem) mem.status = "dispatched";
      }

      return { dispatched: true, identity };
    } catch (err: any) {
      console.warn("[ContinuationDispatcher] native session.promptAsync call threw:", err);
      if (this.db) {
        const curRow = this.db.query(
          "SELECT attempt_count FROM continuation_dispatches WHERE identity = ?"
        ).get(identity) as { attempt_count: number } | null;

        const isExhausted = (curRow?.attempt_count ?? 1) >= maxAttempts;
        const newStatus = isExhausted ? "blocked" : "failed";

        this.db.query(`
          UPDATE continuation_dispatches
          SET status = ?, error = ?
          WHERE identity = ?
        `).run(newStatus, err?.message ?? String(err), identity);
      } else {
        const mem = this.memoryDispatches.get(identity);
        if (mem) {
          mem.status = mem.attemptCount >= maxAttempts ? "blocked" : "failed";
        }
      }
      return { dispatched: false, identity, reason: "native_dispatch_failed" };
    }
  }

  /**
   * Reconcile pending dispatches that survived process shutdown/restart without confirmed completion.
   * Marks them 'outcome_unknown' so they do not cause deadlocks or duplicate autonomous prompts.
   */
  reconcilePendingDispatches(): number {
    if (!this.db) return 0;
    try {
      const now = new Date().toISOString();
      const res = this.db.query(`
        UPDATE continuation_dispatches
        SET status = 'outcome_unknown', error = 'dispatch_outcome_unknown_after_restart', last_attempt_at = ?
        WHERE status = 'pending'
      `).run(now);
      return res.changes;
    } catch {
      return 0;
    }
  }

  reset(): void {
    this.memoryDispatches.clear();
    if (this.db) {
      try {
        this.db.query("DELETE FROM continuation_dispatches").run();
      } catch {}
    }
  }
}
