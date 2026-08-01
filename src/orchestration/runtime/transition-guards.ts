/**
 * Transition validation guards for FlowDeck orchestration runtime.
 * @module orchestration/runtime/transition-guards
 */

import type { State } from "./states.js";
import type { TransitionType } from "./states.js";
import { isTerminalState } from "./states.js";

export interface TransitionContext {
  readonly runId: string;
  readonly timestamp: number;
  readonly reason?: string;
}

export interface GuardResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export type TransitionGuard = (
  from: State,
  to: State,
  context: TransitionContext,
  transitionType: TransitionType
) => GuardResult;

/**
 * Guard that prevents transitions from terminal states.
 */
export function terminalStateGuard(
  from: State,
  to: State,
  _context: TransitionContext,
  _transitionType: TransitionType
): GuardResult {
  if (isTerminalState(from)) {
    return {
      allowed: false,
      reason: `Cannot transition from terminal state: ${from}`,
    };
  }
  return { allowed: true };
}

/**
 * Guard that prevents transitions to the same state.
 */
export function noSelfTransitionGuard(
  from: State,
  to: State,
  _context: TransitionContext,
  _transitionType: TransitionType
): GuardResult {
  if (from === to) {
    return {
      allowed: false,
      reason: `Self-transition not allowed: ${from} -> ${to}`,
    };
  }
  return { allowed: true };
}

/**
 * Guard for planning -> analysing transition.
 */
export function planningToAnalysingGuard(
  from: State,
  to: State,
  _context: TransitionContext,
  _transitionType: TransitionType
): GuardResult {
  // planning -> analysing is a normal forward transition
  // No additional restrictions beyond the transition matrix
  return { allowed: true };
}

/**
 * Guard for analysing -> delegating/executing transition.
 */
export function analysingGuard(
  from: State,
  to: State,
  _context: TransitionContext,
  _transitionType: TransitionType
): GuardResult {
  // analysing -> delegating or executing is allowed
  // No additional restrictions beyond the transition matrix
  return { allowed: true };
}

/**
 * Guard for verifying state transitions.
 */
export function verifyingGuard(
  from: State,
  to: State,
  _context: TransitionContext,
  _transitionType: TransitionType
): GuardResult {
  // verifying can transition to completed, recovering, executing (retry), or failed
  // No additional restrictions beyond the transition matrix
  return { allowed: true };
}

/**
 * Guard for recovering state transitions.
 */
export function recoveringGuard(
  from: State,
  to: State,
  _context: TransitionContext,
  _transitionType: TransitionType
): GuardResult {
  // recovering can transition to executing (retry), failed, or completed
  // No additional restrictions beyond the transition matrix
  return { allowed: true };
}

/**
 * Guard for cancellation from any non-terminal state.
 */
export function cancellationGuard(
  from: State,
  to: State,
  _context: TransitionContext,
  _transitionType: TransitionType
): GuardResult {
  if (to === "cancelled") {
    if (isTerminalState(from)) {
      return {
        allowed: false,
        reason: `Cannot cancel from terminal state: ${from}`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Composite guard that runs all guards in order.
 */
export function composeGuards(...guards: TransitionGuard[]): TransitionGuard {
  return (
    from: State,
    to: State,
    context: TransitionContext,
    transitionType: TransitionType
  ): GuardResult => {
    for (const guard of guards) {
      const result = guard(from, to, context, transitionType);
      if (!result.allowed) {
        return result;
      }
    }
    return { allowed: true };
  };
}

/**
 * Default guard set for all transitions.
 */
export const defaultTransitionGuards = composeGuards(
  terminalStateGuard,
  noSelfTransitionGuard,
  planningToAnalysingGuard,
  analysingGuard,
  verifyingGuard,
  recoveringGuard,
  cancellationGuard
);
