/**
 * FlowDeck orchestration runtime state machine.
 * @module orchestration/runtime
 */

export {
  STATES,
  STATE_CATEGORIES,
  TERMINAL_STATES,
  ACTIVE_STATES,
  ERROR_STATES,
  isTerminalState,
  isActiveState,
  isErrorState,
  getStateCategory,
} from "./states.js";

export type { State, StateCategory, TransitionType } from "./states.js";

export {
  TRANSITION_TABLE,
  getAllowedTransitions,
  canTransition,
  isTransitionAllowed,
} from "./transition-table.js";

export type { TransitionMatrix, TransitionEntry } from "./transition-table.js";

export {
  terminalStateGuard,
  noSelfTransitionGuard,
  planningToAnalysingGuard,
  analysingGuard,
  verifyingGuard,
  recoveringGuard,
  cancellationGuard,
  composeGuards,
  defaultTransitionGuards,
} from "./transition-guards.js";

export type { TransitionContext, GuardResult, TransitionGuard } from "./transition-guards.js";

export {
  StageEventEmitter,
  createStageEntered,
  createStageExited,
  createTransitionFailed,
  createStateMachineError,
} from "./stage-events.js";

export type {
  StageEvent,
  StageEntered,
  StageExited,
  TransitionFailed,
  StateMachineError,
  ErrorCode,
  StageStageEvent,
  EventListener,
} from "./stage-events.js";

export {
  TransitionService,
} from "./transition-service.js";

export type { TransitionResult, TransitionServiceOptions } from "./transition-service.js";

export { InMemoryStateStore } from "./state-store.js";

export type {
  RunState,
  TransitionEvent,
  StateStore,
} from "./state-store.js";
