/**
 * Recovery state types for checkpoint and retry management.
 */

export interface RecoveryState {
  readonly runId: string;
  readonly checkpointId: string;
  readonly recoveryAttempts: number;
  readonly lastCheckpointAt: Date;
  readonly changedHypothesis: boolean;
  readonly retryFingerprint?: string;
  readonly circuitBreakerOpen: boolean;
}

export interface Checkpoint {
  readonly id: string;
  readonly runId: string;
  readonly stateSnapshot: SerializedState;
  readonly createdAt: Date;
  readonly hash: string;
}

export interface SerializedState {
  readonly phase: string;
  readonly progress: number;
  readonly assignments: string[];
  readonly verifications: string[];
  readonly completedTools: string[];
  readonly pendingTools: string[];
  readonly modelCallState?: SerializedModelCallState;
  readonly metadata: Record<string, unknown>;
}

export interface SerializedModelCallState {
  readonly modelId: string;
  readonly prompt: string;
  readonly responseStarted: boolean;
  readonly partialResponse?: string;
}

export interface SerializedCheckpoint {
  id: string;
  runId: string;
  stateSnapshot: SerializedState;
  createdAt: string;
  hash: string;
}

export interface RecoveryDecision {
  readonly shouldRecover: boolean;
  readonly reason: string;
  readonly strategy: RecoveryStrategy;
  readonly maxAttempts: number;
}

export type RecoveryStrategy =
  | "restart"
  | "resume"
  | "replan"
  | "abort";

export const MAX_RECOVERY_ATTEMPTS = 3;

export const DEFAULT_RECOVERY_STRATEGIES: Record<string, RecoveryStrategy> = {
  TIMEOUT: "resume",
  MODEL_ERROR: "replan",
  TOOL_ERROR: "restart",
  CIRCUIT_BREAKER: "abort",
};
