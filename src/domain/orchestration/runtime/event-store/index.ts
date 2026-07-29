/**
 * Event Store Domain - Phase 3B
 * 
 * Exports all event store types, ports, implementations, and utilities
 */

// Types
export {
  EVENT_PAYLOAD_VERSIONS,
  createUncommittedEvent
} from './types';

export type {
  RuntimeEventPayload,
  RuntimeEventPayloadMap,
  RuntimeEventType,
  UncommittedRuntimeEvent,
  PersistedRuntimeEvent,
  // Payload interfaces
  RunCreatedEventPayload,
  RunStartedPlanningEventPayload,
  RunCompletedPlanningEventPayload,
  RunStartedAnalysisEventPayload,
  RunCompletedAnalysisEventPayload,
  RunStartedExecutionEventPayload,
  RunCompletedExecutionEventPayload,
  RunVerifiedEventPayload,
  RunCompletedEventPayload,
  RunFailedEventPayload,
  RunCancelledEventPayload,
  RunRecoveredEventPayload
} from './types';

// Port
export {
  RuntimeEventStorePort,
  isConcurrencyError,
  type AppendResult,
  type ConcurrencyError,
  type DuplicateCheckResult
} from './port.js';

// Implementation
export { InMemoryRuntimeEventStore } from './in-memory-store.js';

// Rehydration
export {
  rehydrateAggregate,
  deterministicReplay,
  validatePersistedEvent,
  type RehydrationResult
} from './rehydration.js';

// Commands
export {
  VersionValidator,
  CommandIdempotencyChecker,
  createStartPlanningCommand,
  createCompletePlanningCommand,
  type RuntimeCommand
} from './commands.js';

export type { BaseCommand } from './commands.js';
