/**
 * ContinuationPolicy — Pure evaluation policy for autonomous continuation turns.
 *
 * Answers: "Should Heidi be asked to take another autonomous turn now?"
 *
 * Rules:
 * - Does NOT mutate state (RunTransitionEngine mutates state).
 * - Enforces positive allowlisted transition reason codes for CONTINUE_NOW.
 * - Idempotent dispatch via ContinuationDispatcher with durable SQLite state.
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
    | "stale_user_turn_version"
    | "stale_run_aggregate_version"
    | "stale_state_fingerprint"
    | "run_not_found";
};

export class ContinuationDispatcher {
  private readonly memoryDispatched = new Set<string>();

  constructor(private readonly db?: Database) {
    if (db) {
      this.ensureTables(db);
    }
  }

  private ensureTables(db: Database): void {
    db.query(`
      CREATE TABLE IF NOT EXISTS continuation_dispatches (
        identity TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_turn_version INTEGER NOT NULL,
        run_aggregate_version INTEGER NOT NULL,
        transition_reason TEXT NOT NULL,
        current_work_item_id TEXT,
        state_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        error TEXT
      )
    `).run();
  }

  computeTokenIdentity(token: ContinuationToken): string {
    const raw = `${token.runId}:${token.sessionId}:${token.userTurnVersion}:${token.runAggregateVersion}:${token.transitionReason}:${token.currentWorkItemId ?? ""}:${token.stateFingerprint}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  /**
   * Validate and dispatch exactly-once continuation with durable SQLite tracking.
   */
  async dispatch(
    token: ContinuationToken,
    opts: {
      statePort?: ContinuationStatePort;
      currentTurnVersion?: number;
      currentAggregateVersion?: number;
      client?: any;
      promptText?: string;
    }
  ): Promise<ContinuationDispatchResult> {
    const identity = this.computeTokenIdentity(token);

    // 1. Authoritative Revalidation against live state port
    if (opts.statePort) {
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
    } else {
      // Fallback version check if statePort omitted
      if (opts.currentTurnVersion !== undefined && token.userTurnVersion !== opts.currentTurnVersion) {
        return { dispatched: false, identity, reason: "stale_user_turn_version" };
      }
      if (opts.currentAggregateVersion !== undefined && token.runAggregateVersion !== opts.currentAggregateVersion) {
        return { dispatched: false, identity, reason: "stale_run_aggregate_version" };
      }
    }

    // 2. Durable Idempotency Check
    if (this.db) {
      const existing = this.db.query(
        "SELECT status FROM continuation_dispatches WHERE identity = ?"
      ).get(identity) as { status: string } | null;

      if (existing && existing.status === "dispatched") {
        return { dispatched: false, identity, reason: "duplicate_dispatch" };
      }
    } else if (this.memoryDispatched.has(identity)) {
      return { dispatched: false, identity, reason: "duplicate_dispatch" };
    }

    // 3. Check native promptAsync availability
    if (!opts.client?.session?.promptAsync) {
      if (this.db) {
        const now = new Date().toISOString();
        this.db.query(`
          INSERT INTO continuation_dispatches (identity, run_id, session_id, user_turn_version, run_aggregate_version, transition_reason, current_work_item_id, state_fingerprint, status, created_at, error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, 'native_dispatch_unavailable')
          ON CONFLICT(identity) DO UPDATE SET status = 'failed', error = 'native_dispatch_unavailable'
        `).run(
          identity,
          token.runId,
          token.sessionId,
          token.userTurnVersion,
          token.runAggregateVersion,
          token.transitionReason,
          token.currentWorkItemId ?? null,
          token.stateFingerprint,
          now
        );
      }
      return { dispatched: false, identity, reason: "native_dispatch_unavailable" };
    }

    // 4. Reserve continuation as pending
    const now = new Date().toISOString();
    if (this.db) {
      this.db.query(`
        INSERT INTO continuation_dispatches (identity, run_id, session_id, user_turn_version, run_aggregate_version, transition_reason, current_work_item_id, state_fingerprint, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(identity) DO UPDATE SET status = 'pending', error = NULL
      `).run(
        identity,
        token.runId,
        token.sessionId,
        token.userTurnVersion,
        token.runAggregateVersion,
        token.transitionReason,
        token.currentWorkItemId ?? null,
        token.stateFingerprint,
        now
      );
    }

    // 5. Invoke native OpenCode promptAsync
    try {
      const res = await opts.client.session.promptAsync({
        path: { id: token.sessionId },
        body: {
          parts: [{ type: "text", text: opts.promptText ?? "Continue with the next planned step." }],
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
        this.memoryDispatched.add(identity);
      }

      return { dispatched: true, identity };
    } catch (err: any) {
      console.warn("[ContinuationDispatcher] native session.promptAsync call threw:", err);
      if (this.db) {
        this.db.query(`
          UPDATE continuation_dispatches
          SET status = 'failed', error = ?
          WHERE identity = ?
        `).run(err?.message ?? String(err), identity);
      }
      return { dispatched: false, identity, reason: "native_dispatch_failed" };
    }
  }

  reset(): void {
    this.memoryDispatched.clear();
    if (this.db) {
      try {
        this.db.query("DELETE FROM continuation_dispatches").run();
      } catch {}
    }
  }
}
