/**
 * Trace replay module for FlowDeck.
 * Provides deterministic replay of recorded agent traces.
 * @module orchestration/runtime/trace-replay
 */

// Schema types
export {
  TRACE_SCHEMA_VERSION,
  MIN_SUPPORTED_VERSION,
  MAX_SUPPORTED_VERSION,
} from "./trace-schema.js";

export type {
  TraceEvent,
  TraceEventType,
  TracePayload,
  ReplayResult,
  ReplayState,
  ModelAdapter,
  ToolAdapter,
  ReplayClock,
  TaskStartedPayload,
  TaskCompletedPayload,
  SpecialistInvokedPayload,
  SpecialistCompletedPayload,
  SpecialistFailedPayload,
  ToolCalledPayload,
  ToolResultPayload,
  ToolErrorPayload,
  VerificationStartedPayload,
  VerificationCompletedPayload,
  CancellationRequestedPayload,
  ModelRequestPayload,
  ModelResponsePayload,
  UnknownPayload,
} from "./trace-schema.js";

// Validation
export {
  validateEventStructure,
  validateEventVersion,
  validateRequiredFields,
  validateTrace,
} from "./trace-validator.js";

export type {
  ValidationError,
  ValidationResult,
} from "./trace-validator.js";

// Comparison
export {
  validateEventOrder,
  validateReproducibility,
  compareTraces,
  getMismatchDiagnostics,
} from "./event-comparator.js";

export type {
  ComparisonResult,
  EventDifference,
} from "./event-comparator.js";

// Replayer
export {
  replayTrace,
  TraceValidationError,
} from "./trace-replayer.js";

export type {
  ReplayOptions,
} from "./trace-replayer.js";
