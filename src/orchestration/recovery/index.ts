/**
 * FlowDeck Cancellation and Recovery Runtime
 *
 * Barrel export for the recovery module.
 */

// Cancellation token types
export {
  type CancellationToken,
  type CancellationOptions,
  type CancellationTokenFactory,
  type SerializedCancellationToken,
  serializeToken,
  deserializeToken,
} from "./cancellation-token";

// Cancellation service
export {
  CancellationService,
  type CancellationServiceConfig,
  type CancellationEvent,
  type CancellationEventHandler,
  type CheckpointRepositoryPort,
  type OwnershipPort,
  CancellationTokenSchema,
  CheckpointSchema,
} from "./cancellation-service";

// Recovery state types
export {
  type RecoveryState,
  type Checkpoint,
  type SerializedState,
  type SerializedModelCallState,
  type SerializedCheckpoint,
  type RecoveryDecision,
  type RecoveryStrategy,
  MAX_RECOVERY_ATTEMPTS,
  DEFAULT_RECOVERY_STRATEGIES,
} from "./recovery-state";

// Circuit breaker
export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  type CircuitState,
  type CircuitBreakerConfig,
  type CircuitBreakerMetrics,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "./circuit-breaker";

// Recovery strategy
export {
  type RecoveryStrategyConfig,
  DEFAULT_RECOVERY_STRATEGY_CONFIG,
  type HypothesisFingerprint,
  computeHypothesisFingerprint,
  evaluateRecovery,
  determineRestartStrategy,
  HypothesisTracker,
} from "./recovery-strategy";
