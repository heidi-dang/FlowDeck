/**
 * Valid state transition matrix for FlowDeck orchestration runtime.
 * @module orchestration/runtime/transition-table
 */

import type { State } from "./states.js";

export interface TransitionEntry {
  readonly allowed: readonly State[];
}

export type TransitionMatrix = Readonly<Record<State, TransitionEntry>>;

/**
 * Transition table defining valid state transitions.
 * Any state can transition to `cancelled` if it's not terminal.
 */
export const TRANSITION_TABLE: TransitionMatrix = {
  created: {
    allowed: ["planning"],
  },
  planning: {
    allowed: ["analysing"],
  },
  analysing: {
    allowed: ["delegating", "executing"],
  },
  delegating: {
    allowed: ["executing"],
  },
  executing: {
    allowed: ["verifying"],
  },
  verifying: {
    allowed: ["completed", "recovering", "executing", "failed"],
  },
  recovering: {
    allowed: ["executing", "failed", "completed"],
  },
  completed: {
    allowed: [],
  },
  failed: {
    allowed: [],
  },
  cancelled: {
    allowed: [],
  },
} as const;

export function getAllowedTransitions(from: State): readonly State[] {
  return TRANSITION_TABLE[from].allowed;
}

export function canTransition(from: State, to: State): boolean {
  // Any non-terminal state can transition to cancelled
  if (to === "cancelled") {
    const allowed = TRANSITION_TABLE[from].allowed;
    return allowed.length >= 0; // All non-terminal states can go to cancelled
  }
  return TRANSITION_TABLE[from].allowed.includes(to);
}

export function isTransitionAllowed(from: State, to: State): boolean {
  // Terminal states cannot transition anywhere
  if (
    from === "completed" ||
    from === "failed" ||
    from === "cancelled"
  ) {
    return false;
  }
  // Any non-terminal can go to cancelled
  if (to === "cancelled") {
    return true;
  }
  return TRANSITION_TABLE[from].allowed.includes(to);
}
