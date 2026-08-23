/**
 * ContinuationPolicy — Pure evaluation policy for autonomous continuation turns.
 *
 * Answers: "Should Heidi be asked to take another autonomous turn now?"
 *
 * Rules:
 * - Does NOT mutate state (RunTransitionEngine mutates state).
 * - Enforces positive allowlisted transition reason codes for CONTINUE_NOW.
 * - Idempotent dispatch via ContinuationDispatcher.
 * - Enforces continuation gates: Run active, matching user-turn version, matching aggregate version,
 *   no active background child, not blocked, not terminal.
 */

import { createHash } from "node:crypto";
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
    if (snapshot.childState.active > 0 || transition.reasonCode === "WAITING_FOR_CHILDREN") {
      return { decision: "WAIT_FOR_CHILD", reason: "Active child executions in progress" };
    }

    // 4. Blocked conditions
    if (transition.strategyDecision === "BLOCK" || transition.reasonCode === "BLOCKED") {
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

export class ContinuationDispatcher {
  private readonly dispatchedTokens = new Set<string>();

  computeTokenIdentity(token: ContinuationToken): string {
    const raw = `${token.runId}:${token.sessionId}:${token.userTurnVersion}:${token.runAggregateVersion}:${token.transitionReason}:${token.currentWorkItemId ?? ""}:${token.stateFingerprint}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  /**
   * Validate and dispatch exactly-once continuation.
   */
  async dispatch(
    token: ContinuationToken,
    opts: {
      currentTurnVersion: number;
      currentAggregateVersion: number;
      client?: any;
      promptText?: string;
    }
  ): Promise<{ dispatched: boolean; identity: string; reason?: string }> {
    // 1. Revalidate stale versions
    if (token.userTurnVersion !== opts.currentTurnVersion) {
      return { dispatched: false, identity: "", reason: "stale_user_turn_version" };
    }

    if (token.runAggregateVersion !== opts.currentAggregateVersion) {
      return { dispatched: false, identity: "", reason: "stale_run_aggregate_version" };
    }

    // 2. Check duplicate dispatch
    const identity = this.computeTokenIdentity(token);
    if (this.dispatchedTokens.has(identity)) {
      return { dispatched: false, identity, reason: "duplicate_dispatch" };
    }

    this.dispatchedTokens.add(identity);

    // 3. Native OpenCode continuation if client session API is available
    if (opts.client?.session?.promptAsync && token.sessionId) {
      try {
        await opts.client.session.promptAsync({
          path: { id: token.sessionId },
          body: {
            parts: [{ type: "text", text: opts.promptText ?? "Continue with the next planned step." }],
            agent: "heidi",
          },
        });
      } catch (err) {
        console.warn("[ContinuationDispatcher] native session.promptAsync call threw:", err);
      }
    }

    return { dispatched: true, identity };
  }

  reset(): void {
    this.dispatchedTokens.clear();
  }
}
