/**
 * Semantic Completion Gates - Barrel Export
 *
 * Export all public types and functions for the completion gate system.
 */

export {
  CompletionGate,
  ALL_GATES,
  type GateResult,
  type CompletionGateInput,
} from "./completion-gates"

export {
  evaluateAllGates,
  evaluateGate,
  type AggregatedGateResult,
} from "./completion-evaluator"

export {
  CompletionEngine,
  type CompletionCheckResult,
  type IdempotencyRecord,
} from "./completion-engine"
