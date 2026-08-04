/**
 * Recovery strategy types and rule evaluation.
 *
 * Recovery is bounded and guided by:
 * - Changed-hypothesis rule: don't retry if the same approach failed
 * - Retry fingerprinting: track what was attempted
 * - Max recovery attempts: hard limit on retries
 * - Restart reconciliation: determine if restart or resume
 */

import type {
  RecoveryState,
  RecoveryDecision,
  RecoveryStrategy,
  SerializedState,
} from "./recovery-state";

export interface RecoveryStrategyConfig {
  readonly maxRecoveryAttempts: number;
  readonly changedHypothesisEnabled: boolean;
  readonly fingerprintWindowMs: number;
}

export const DEFAULT_RECOVERY_STRATEGY_CONFIG: RecoveryStrategyConfig = {
  maxRecoveryAttempts: 3,
  changedHypothesisEnabled: true,
  fingerprintWindowMs: 300_000, // 5 minutes
};

export interface HypothesisFingerprint {
  readonly fingerprint: string;
  readonly strategy: RecoveryStrategy;
  readonly timestamp: Date;
}

/**
 * Compute a fingerprint for the current execution state.
 * Two executions with the same fingerprint are considered to have
 * the "same hypothesis" and should not be retried identically.
 */
export function computeHypothesisFingerprint(
  state: SerializedState,
  strategy: RecoveryStrategy,
): string {
  const components = [
    state.phase,
    state.progress,
    JSON.stringify(state.assignments.slice().sort()),
    JSON.stringify(state.completedTools.slice().sort()),
    strategy,
  ];
  return components.join("|");
}

/**
 * Evaluate whether recovery should proceed based on current state
 * and past attempt history.
 */
export function evaluateRecovery(
  currentState: RecoveryState,
  config: RecoveryStrategyConfig = DEFAULT_RECOVERY_STRATEGY_CONFIG,
): RecoveryDecision {
  // Hard limit on recovery attempts
  if (currentState.recoveryAttempts >= config.maxRecoveryAttempts) {
    return {
      shouldRecover: false,
      reason: "MAX_RECOVERY_ATTEMPTS_EXCEEDED",
      strategy: "abort",
      maxAttempts: config.maxRecoveryAttempts,
    };
  }

  // Circuit breaker is open — abort
  if (currentState.circuitBreakerOpen) {
    return {
      shouldRecover: false,
      reason: "CIRCUIT_BREAKER_OPEN",
      strategy: "abort",
      maxAttempts: config.maxRecoveryAttempts,
    };
  }

  // Changed-hypothesis check
  if (config.changedHypothesisEnabled && currentState.changedHypothesis === false) {
    return {
      shouldRecover: false,
      reason: "UNCHANGED_HYPOTHESIS",
      strategy: "replan",
      maxAttempts: config.maxRecoveryAttempts,
    };
  }

  return {
    shouldRecover: true,
    reason: "RECOVERY_ELIGIBLE",
    strategy: "resume",
    maxAttempts: config.maxRecoveryAttempts,
  };
}

/**
 * Determine the appropriate restart/reconcile strategy based on failure type.
 */
export function determineRestartStrategy(
  failureType: string,
  currentState: SerializedState,
): RecoveryStrategy {
  // If no work has been done, replan is appropriate
  if (currentState.completedTools.length === 0 && currentState.assignments.length === 0) {
    return "replan";
  }

  // If model call was in progress, replan may help
  if (currentState.modelCallState?.responseStarted === false) {
    return "replan";
  }

  // Tool failures typically benefit from restart
  if (failureType === "TOOL_ERROR") {
    return "restart";
  }

  // Model errors benefit from replan
  if (failureType === "MODEL_ERROR") {
    return "replan";
  }

  // Timeout can usually be resumed
  if (failureType === "TIMEOUT") {
    return "resume";
  }

  return "restart";
}

export class HypothesisTracker {
  private history: HypothesisFingerprint[] = [];
  private readonly windowMs: number;

  constructor(windowMs: number = DEFAULT_RECOVERY_STRATEGY_CONFIG.fingerprintWindowMs) {
    this.windowMs = windowMs;
  }

  record(fingerprint: string, strategy: RecoveryStrategy): void {
    this.history.push({
      fingerprint,
      strategy,
      timestamp: new Date(),
    });
    this.prune();
  }

  hasChanged(previousFingerprint: string, currentFingerprint: string): boolean {
    return previousFingerprint !== currentFingerprint;
  }

  getLastFingerprint(): string | undefined {
    if (this.history.length === 0) return undefined;
    return this.history[this.history.length - 1].fingerprint;
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.history = this.history.filter((h) => h.timestamp.getTime() > cutoff);
  }
}
