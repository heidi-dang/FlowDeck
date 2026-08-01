/**
 * State persistence interfaces for FlowDeck orchestration runtime.
 * @module orchestration/runtime/state-store
 */

import type { State } from "./states.js";
import type { TransitionType } from "./states.js";

export interface RunState {
  readonly runId: string;
  readonly state: State;
  readonly version: number;
  readonly lastUpdated: Date;
}

export interface TransitionEvent {
  readonly runId: string;
  readonly from: State;
  readonly to: State;
  readonly transitionType: TransitionType;
  readonly timestamp: number;
}

export interface StateStore {
  loadState(runId: string): Promise<RunState | null>;
  saveState(
    runId: string,
    state: State,
    expectedVersion: number
  ): Promise<boolean>;
  recordEvent(runId: string, event: TransitionEvent): Promise<void>;
}

/**
 * Simple in-memory implementation of StateStore for testing and development.
 * Uses per-run optimistic concurrency via version numbers.
 */
export class InMemoryStateStore implements StateStore {
  private readonly states: Map<string, RunState> = new Map();
  private readonly events: Map<string, TransitionEvent[]> = new Map();

  async loadState(runId: string): Promise<RunState | null> {
    return this.states.get(runId) ?? null;
  }

  async saveState(
    runId: string,
    state: State,
    expectedVersion: number
  ): Promise<boolean> {
    const current = this.states.get(runId);
    if (current && current.version !== expectedVersion) {
      return false;
    }
    const newVersion = current ? current.version + 1 : 0;
    this.states.set(runId, {
      runId,
      state,
      version: newVersion,
      lastUpdated: new Date(),
    });
    return true;
  }

  async recordEvent(
    runId: string,
    event: TransitionEvent
  ): Promise<void> {
    const existing = this.events.get(runId) ?? [];
    this.events.set(runId, [...existing, event]);
  }
}
