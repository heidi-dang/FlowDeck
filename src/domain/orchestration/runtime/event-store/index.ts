/**
 * Event Store Domain - Phase 3B
 * 
 * Exports all event store types, ports, implementations, and utilities
 */

// Types
export {
  EVENT_PAYLOAD_VERSIONS
} from './types';

export type {
  RuntimeEventPayload,
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
} from './port';

// Implementation
export { InMemoryRuntimeEventStore } from './in-memory-store';

// ID generators
export { 
  defaultEventIdGenerator,
  defaultAppendIdGenerator,
  createDeterministicGenerators
} from './event-id-generator.js';

export type { AppendIdGenerator } from './types.js';

// Rehydration
export {
  rehydrateAggregate,
  deterministicReplay,
  validatePersistedEvent,
  type RehydrationResult
} from './rehydration';

// Commands
export {
  VersionValidator,
  CommandIdempotencyChecker,
  createStartPlanningCommand,
  createCompletePlanningCommand,
  type RuntimeCommand
} from './commands';

export type { BaseCommand } from './commands';
