/**
 * ContinuationPolicy — Pure evaluation policy for autonomous continuation turns.
 *
 * Answers: "Should Heidi be asked to take another autonomous turn now?"
 *
 * Rules:
 * - Does NOT mutate state (RunTransitionEngine mutates state).
 * - Distinguishes CONTINUE_NOW, WAIT_FOR_CHILD, WAIT_FOR_USER, REPLAN, STOP_TERMINAL, STOP_BLOCKED.
 * - Enforces continuation gates: Run active, no newer real user turn, no active background child,
 *   not blocked, not terminal.
 */

import type { OrchestrationSnapshot } from "./orchestration-snapshot-service";
import type { TransitionEvaluationResult } from "./transition-engine";
import { TERMINAL_PHASES } from "./transition-engine";

export type ContinuationDecision =
  | "CONTINUE_NOW"
  | "WAIT_FOR_CHILD"
  | "WAIT_FOR_USER"
  | "REPLAN"
  | "STOP_TERMINAL"
  | "STOP_BLOCKED";

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

    // 6. Action required and legal strategy available -> continue now
    if (transition.requiresAction) {
      return { decision: "CONTINUE_NOW", reason: `Action required: ${transition.reasonCode}` };
    }

    return { decision: "WAIT_FOR_USER", reason: "No autonomous action pending" };
  }
}
