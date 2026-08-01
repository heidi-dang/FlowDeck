/**
 * Transition execution service for FlowDeck orchestration runtime.
 * @module orchestration/runtime/transition-service
 */

import type { State } from "./states.js";
import type { TransitionType } from "./states.js";
import { isTerminalState } from "./states.js";
import { isTransitionAllowed } from "./transition-table.js";
import type { TransitionContext, TransitionGuard } from "./transition-guards.js";
import { defaultTransitionGuards } from "./transition-guards.js";
import {
  StageEventEmitter,
  createStageEntered,
  createStageExited,
  createTransitionFailed,
  createStateMachineError,
} from "./stage-events.js";
import type { StageStageEvent } from "./stage-events.js";

export interface TransitionResult {
  readonly success: boolean;
  readonly from: State;
  readonly to: State;
  readonly transitionType: TransitionType;
  readonly error?: string;
}

export interface TransitionServiceOptions {
  readonly guards?: TransitionGuard;
  readonly eventEmitter?: StageEventEmitter;
}

/**
 * Service for executing state transitions with guards and event emission.
 */
export class TransitionService {
  private readonly guards: TransitionGuard;
  private readonly eventEmitter: StageEventEmitter;
  private transitioning = false;

  constructor(options: TransitionServiceOptions = {}) {
    this.guards = options.guards ?? defaultTransitionGuards;
    this.eventEmitter = options.eventEmitter ?? new StageEventEmitter();
  }

  /**
   * Check if a transition can be performed without executing it.
   */
  canTransition(
    from: State,
    to: State,
    context: TransitionContext,
    transitionType: TransitionType = "normal"
  ): boolean {
    // Check if already transitioning (concurrency safety)
    if (this.transitioning) {
      return false;
    }

    // Check if transition is in the allowed matrix
    if (!isTransitionAllowed(from, to)) {
      return false;
    }

    // Run guards
    const guardResult = this.guards(from, to, context, transitionType);
    return guardResult.allowed;
  }

  /**
   * Execute a state transition with guards and event emission.
   */
  executeTransition(
    runId: string,
    from: State,
    to: State,
    context: TransitionContext,
    transitionType: TransitionType = "normal"
  ): TransitionResult {
    // Concurrency safety - prevent concurrent transitions
    if (this.transitioning) {
      const errorEvent = createStateMachineError(
        runId,
        from,
        "Concurrent transition detected",
        "CONCURRENT_TRANSITION"
      );
      this.eventEmitter.emit(errorEvent);
      return {
        success: false,
        from,
        to,
        transitionType,
        error: "Concurrent transition detected",
      };
    }

    // Terminal state protection
    if (isTerminalState(from)) {
      const errorEvent = createStateMachineError(
        runId,
        from,
        `Cannot transition from terminal state: ${from}`,
        "TERMINAL_STATE_VIOLATION"
      );
      this.eventEmitter.emit(errorEvent);
      return {
        success: false,
        from,
        to,
        transitionType,
        error: `Cannot transition from terminal state: ${from}`,
      };
    }

    // Check transition matrix
    if (!isTransitionAllowed(from, to)) {
      const failedEvent = createTransitionFailed(
        runId,
        from,
        to,
        `Invalid transition: ${from} -> ${to}`,
        transitionType
      );
      this.eventEmitter.emit(failedEvent);
      return {
        success: false,
        from,
        to,
        transitionType,
        error: `Invalid transition: ${from} -> ${to}`,
      };
    }

    // Run guards
    const guardResult = this.guards(from, to, context, transitionType);
    if (!guardResult.allowed) {
      const failedEvent = createTransitionFailed(
        runId,
        from,
        to,
        guardResult.reason ?? "Guard rejected transition",
        transitionType
      );
      this.eventEmitter.emit(failedEvent);
      return {
        success: false,
        from,
        to,
        transitionType,
        error: guardResult.reason ?? "Guard rejected transition",
      };
    }

    // Execute transition
    this.transitioning = true;
    try {
      // Emit StageExited event
      const exitEvent = createStageExited(runId, from, to, transitionType);
      this.eventEmitter.emit(exitEvent);

      // Emit StageEntered event
      const enterEvent = createStageEntered(runId, to, from, transitionType);
      this.eventEmitter.emit(enterEvent);

      return { success: true, from, to, transitionType };
    } catch (error) {
      const errorEvent = createStateMachineError(
        runId,
        from,
        error instanceof Error ? error.message : "Unknown error",
        "UNKNOWN_ERROR"
      );
      this.eventEmitter.emit(errorEvent);
      return {
        success: false,
        from,
        to,
        transitionType,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      this.transitioning = false;
    }
  }

  /**
   * Subscribe to stage events.
   */
  subscribe(listener: (event: StageStageEvent) => void): () => void {
    return this.eventEmitter.subscribe(listener);
  }

  /**
   * Get the event emitter for direct access.
   */
  getEventEmitter(): StageEventEmitter {
    return this.eventEmitter;
  }

  /**
   * Check if currently transitioning (concurrency safety).
   */
  isTransitioning(): boolean {
    return this.transitioning;
  }
}
