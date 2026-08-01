/**
 * Transition execution service for FlowDeck orchestration runtime.
 * @module orchestration/runtime/transition-service
 */

import type { State } from "./states.js";
import type { TransitionType } from "./states.js";
import { isTerminalState } from "./states.js";
import { isTransitionAllowed } from "./transition-table.js";
import type {
  TransitionContext,
  TransitionGuard,
} from "./transition-guards.js";
import { defaultTransitionGuards } from "./transition-guards.js";
import {
  StageEventEmitter,
  createStageEntered,
  createStageExited,
  createTransitionFailed,
  createStateMachineError,
} from "./stage-events.js";
import type { StageStageEvent } from "./stage-events.js";
import type {
  StateStore,
  TransitionEvent,
} from "./state-store.js";
import { InMemoryStateStore } from "./state-store.js";

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
  readonly stateStore?: StateStore;
}

/**
 * Service for executing state transitions with persistence, guards, and event emission.
 *
 * Implements the required flow:
 *   load authoritative run state
 *   → verify expected version
 *   → validate transition
 *   → evaluate guard
 *   → persist new state and transition event atomically
 *   → publish committed event
 */
export class TransitionService {
  private readonly guards: TransitionGuard;
  private readonly eventEmitter: StageEventEmitter;
  private readonly stateStore: StateStore;
  private readonly runLocks: Map<string, Promise<void>> = new Map();

  constructor(options: TransitionServiceOptions = {}) {
    this.guards = options.guards ?? defaultTransitionGuards;
    this.eventEmitter = options.eventEmitter ?? new StageEventEmitter();
    this.stateStore = options.stateStore ?? new InMemoryStateStore();
  }

  /**
   * Acquire a per-run lock. Blocks until no transition for this run is in flight.
   */
  private async acquireRunLock(runId: string): Promise<() => void> {
    const existing = this.runLocks.get(runId);
    let resolvePrev: () => void;
    const myPromise = new Promise<void>((resolve) => {
      resolvePrev = resolve;
    });
    this.runLocks.set(runId, myPromise);
    await (existing ?? Promise.resolve());
    return () => {
      resolvePrev!();
      // Clean up the lock entry after releasing
      const current = this.runLocks.get(runId);
      if (current === myPromise) {
        this.runLocks.delete(runId);
      }
    };
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
   *
   * Loads authoritative state from the store instead of trusting the caller's
   * `from` value, verifies the expected version, validates the transition,
   * evaluates guards, then persists state + event atomically before publishing.
   *
   * @param runId           The run identifier
   * @param from            Expected current state (for version verification)
   * @param to              Target state
   * @param context         Transition context (must include runId and timestamp)
   * @param transitionType  Type of transition (normal/retry/forced)
   * @param expectedVersion Expected state version for optimistic concurrency
   */
  async executeTransition(
    runId: string,
    from: State,
    to: State,
    context: TransitionContext,
    transitionType: TransitionType = "normal",
    expectedVersion?: number
  ): Promise<TransitionResult> {
    // Per-run concurrency control: only one transition per run at a time
    const release = await this.acquireRunLock(runId);
    try {
      // Step 1: Load authoritative run state from the store
      const runState = await this.stateStore.loadState(runId);

      let actualState: State;
      let actualVersion: number;

      if (runState) {
        actualState = runState.state;
        actualVersion = runState.version;

        // Step 2: Verify expected version (optimistic concurrency)
        if (
          expectedVersion !== undefined &&
          expectedVersion !== actualVersion
        ) {
          const errorEvent = createStateMachineError(
            runId,
            actualState,
            `Version conflict: expected ${expectedVersion}, got ${actualVersion}`,
            "CONCURRENT_TRANSITION"
          );
          this.eventEmitter.emit(errorEvent);
          return {
            success: false,
            from: actualState,
            to,
            transitionType,
            error: `Version conflict: expected ${expectedVersion}, got ${actualVersion}`,
          };
        }

        // Use authoritative state as the real "from"
        if (actualState !== from) {
          const errorEvent = createStateMachineError(
            runId,
            actualState,
            `State mismatch: expected ${from}, got ${actualState}`,
            "CONCURRENT_TRANSITION"
          );
          this.eventEmitter.emit(errorEvent);
          return {
            success: false,
            from: actualState,
            to,
            transitionType,
            error: `State mismatch: expected ${from}, got ${actualState}`,
          };
        }
      } else {
        // No stored state — initialize at version -1 so first save goes to 0
        actualState = from;
        actualVersion = -1;
      }

      // Step 3: Validate transition (terminal state protection + matrix)
      if (isTerminalState(actualState)) {
        const errorEvent = createStateMachineError(
          runId,
          actualState,
          `Cannot transition from terminal state: ${actualState}`,
          "TERMINAL_STATE_VIOLATION"
        );
        this.eventEmitter.emit(errorEvent);
        return {
          success: false,
          from: actualState,
          to,
          transitionType,
          error: `Cannot transition from terminal state: ${actualState}`,
        };
      }

      if (!isTransitionAllowed(actualState, to)) {
        const failedEvent = createTransitionFailed(
          runId,
          actualState,
          to,
          `Invalid transition: ${actualState} -> ${to}`,
          transitionType
        );
        this.eventEmitter.emit(failedEvent);
        return {
          success: false,
          from: actualState,
          to,
          transitionType,
          error: `Invalid transition: ${actualState} -> ${to}`,
        };
      }

      // Step 4: Evaluate guard
      const guardResult = this.guards(
        actualState,
        to,
        context,
        transitionType
      );
      if (!guardResult.allowed) {
        const failedEvent = createTransitionFailed(
          runId,
          actualState,
          to,
          guardResult.reason ?? "Guard rejected transition",
          transitionType
        );
        this.eventEmitter.emit(failedEvent);
        return {
          success: false,
          from: actualState,
          to,
          transitionType,
          error: guardResult.reason ?? "Guard rejected transition",
        };
      }

      // Step 5: Build the transition event
      const transitionEvent: TransitionEvent = {
        runId,
        from: actualState,
        to,
        transitionType,
        timestamp: context.timestamp ?? Date.now(),
      };

      // Step 6: Persist atomically — verify version, then save state + event
      // The store's saveState checks the expected version internally.
      const saved = await this.stateStore.saveState(
        runId,
        to,
        actualVersion
      );

      if (!saved) {
        const errorEvent = createStateMachineError(
          runId,
          actualState,
          `Concurrent modification: state was updated by another process`,
          "CONCURRENT_TRANSITION"
        );
        this.eventEmitter.emit(errorEvent);
        return {
          success: false,
          from: actualState,
          to,
          transitionType,
          error: `Concurrent modification: state was updated by another process`,
        };
      }

      // Record the transition event (atomic with state persistence in a real
      // transactional store; here we emit the event after commit succeeds)
      await this.stateStore.recordEvent(runId, transitionEvent);

      // Step 7: Publish committed event
      const exitEvent = createStageExited(runId, actualState, to, transitionType);
      this.eventEmitter.emit(exitEvent);

      const enterEvent = createStageEntered(runId, to, actualState, transitionType);
      this.eventEmitter.emit(enterEvent);

      return { success: true, from: actualState, to, transitionType };
    } catch (error) {
      const runStateForError = await this.stateStore.loadState(runId);
      const errorState = runStateForError?.state ?? from;
      const errorEvent = createStateMachineError(
        runId,
        errorState,
        error instanceof Error ? error.message : "Unknown error",
        "UNKNOWN_ERROR"
      );
      this.eventEmitter.emit(errorEvent);
      return {
        success: false,
        from: errorState,
        to,
        transitionType,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      release();
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
   * Get the state store used by this service.
   */
  getStateStore(): StateStore {
    return this.stateStore;
  }
}
