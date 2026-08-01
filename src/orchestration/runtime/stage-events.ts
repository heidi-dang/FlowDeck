/**
 * Stage event system for FlowDeck orchestration runtime.
 * @module orchestration/runtime/stage-events
 */

import type { State } from "./states.js";
import type { TransitionType } from "./states.js";

export interface StageEvent {
  readonly type: string;
  readonly timestamp: number;
  readonly runId: string;
}

export interface StageEntered extends StageEvent {
  readonly type: "StageEntered";
  readonly state: State;
  readonly previousState: State | null;
  readonly transitionType: TransitionType;
}

export interface StageExited extends StageEvent {
  readonly type: "StageExited";
  readonly state: State;
  readonly nextState: State | null;
  readonly transitionType: TransitionType;
}

export interface TransitionFailed extends StageEvent {
  readonly type: "TransitionFailed";
  readonly from: State;
  readonly to: State;
  readonly reason: string;
  readonly transitionType: TransitionType;
}

export interface StateMachineError extends StageEvent {
  readonly type: "StateMachineError";
  readonly state: State;
  readonly error: string;
  readonly code: ErrorCode;
}

export type ErrorCode =
  | "INVALID_TRANSITION"
  | "TERMINAL_STATE_VIOLATION"
  | "GUARD_REJECTED"
  | "CONCURRENT_TRANSITION"
  | "UNKNOWN_ERROR";

export type StageStageEvent = StageEntered | StageExited | TransitionFailed | StateMachineError;

export type EventListener = (event: StageStageEvent) => void;

export class StageEventEmitter {
  private listeners: Set<EventListener> = new Set();
  private listenerCount = 0;

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    this.listenerCount++;
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: StageStageEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors to avoid destabilizing the emitter
      }
    }
  }

  getSubscriberCount(): number {
    return this.listenerCount;
  }
}

export function createStageEntered(
  runId: string,
  state: State,
  previousState: State | null,
  transitionType: TransitionType
): StageEntered {
  return {
    type: "StageEntered",
    timestamp: Date.now(),
    runId,
    state,
    previousState,
    transitionType,
  };
}

export function createStageExited(
  runId: string,
  state: State,
  nextState: State | null,
  transitionType: TransitionType
): StageExited {
  return {
    type: "StageExited",
    timestamp: Date.now(),
    runId,
    state,
    nextState,
    transitionType,
  };
}

export function createTransitionFailed(
  runId: string,
  from: State,
  to: State,
  reason: string,
  transitionType: TransitionType
): TransitionFailed {
  return {
    type: "TransitionFailed",
    timestamp: Date.now(),
    runId,
    from,
    to,
    reason,
    transitionType,
  };
}

export function createStateMachineError(
  runId: string,
  state: State,
  error: string,
  code: ErrorCode
): StateMachineError {
  return {
    type: "StateMachineError",
    timestamp: Date.now(),
    runId,
    state,
    error,
    code,
  };
}
