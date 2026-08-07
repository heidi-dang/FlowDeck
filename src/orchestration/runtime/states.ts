/**
 * State machine states for FlowDeck orchestration runtime.
 * @module orchestration/runtime/states
 */

export const STATES = [
  "created",
  "planning",
  "analysing",
  "delegating",
  "executing",
  "verifying",
  "recovering",
  "completed",
  "failed",
  "cancelled",
] as const;

export type State = (typeof STATES)[number];

export type StateCategory = "active" | "terminal" | "error";

export type TransitionType = "normal" | "retry" | "forced";

export const STATE_CATEGORIES: Record<State, StateCategory> = {
  created: "active",
  planning: "active",
  analysing: "active",
  delegating: "active",
  executing: "active",
  verifying: "active",
  recovering: "active",
  completed: "terminal",
  failed: "error",
  cancelled: "terminal",
} as const;

export const TERMINAL_STATES: readonly State[] = ["completed", "failed", "cancelled"] as const;

export const ACTIVE_STATES: readonly State[] = [
  "created",
  "planning",
  "analysing",
  "delegating",
  "executing",
  "verifying",
  "recovering",
] as const;

export const ERROR_STATES: readonly State[] = ["failed", "cancelled"] as const;

export function isTerminalState(state: State): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isActiveState(state: State): boolean {
  return ACTIVE_STATES.includes(state);
}

export function isErrorState(state: State): boolean {
  return ERROR_STATES.includes(state);
}

export function getStateCategory(state: State): StateCategory {
  return STATE_CATEGORIES[state];
}
