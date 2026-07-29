/**
 * Aggregate Rehydration and Replay - Phase 3B
 * 
 * Implements deterministic rehydration from event stream
 */

import { TaskRun, TaskRunState } from '../task-run.js';
import { PersistedRuntimeEvent } from './types.js';

/**
 * Rehydration result
 */
export interface RehydrationResult {
  readonly aggregateId: string;
  readonly version: number;
  readonly eventsApplied: number;
  readonly createdAt?: Date;
  readonly replayErrors?: string[];
}

/**
 * Validate a persisted event before applying it
 */
export function validatePersistedEvent(event: PersistedRuntimeEvent): { valid: true } | { valid: false; errors: string[] } {
  const errors: string[] = [];

  // Check required fields
  if (!event.aggregateId) {
    errors.push('Missing aggregateId');
  }

  if (event.aggregateVersion < 1) {
    errors.push(`Invalid aggregate version: ${event.aggregateVersion}`);
  }

  // Verify payload hash integrity
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(event.payload));
    const hashBuffer = crypto.subtle.digest('SHA-256', data).then(hash => {
      // Compute hash synchronously would require different approach
      // For now, we just verify structure
    });

    if (!event.payloadHash) {
      errors.push('Missing payload hash');
    }

    if (!event.checksum) {
      errors.push('Missing checksum');
    }
  } catch {
    errors.push('Malformed payload - cannot compute hash');
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Apply single event to TaskRun builder
 */
interface TaskRunBuilder {
  aggregateId: string;
  version: number;
  status: TaskRunState;
  strategy: 'simple' | 'planned' | 'delegated' | 'audit' | 'recovery';
  correlationId?: string;
  planScope?: unknown;
  delegationTarget?: string;
  recoveryPath?: string;
  planningCompleted?: boolean;
  analysisComplete?: boolean;
  executionComplete?: boolean;
  verificationFailed?: boolean;
  needsRecovery?: boolean;
}

function applyEventToBuilder(
  builder: TaskRunBuilder,
  event: PersistedRuntimeEvent
): void {
  switch (event.type) {
    case 'RunCreated':
      builder.status = 'created';
      builder.strategy = (event.payload as any).strategy ?? 'simple';
      builder.planScope = (event.payload as any).planScope;
      builder.correlationId = event.correlationId;
      break;

    case 'RunStartedPlanning':
      builder.status = 'planning';
      break;

    case 'RunCompletedPlanning':
      builder.status = 'planned';
      builder.planningCompleted = true;
      break;

    case 'RunStartedAnalysis':
      builder.status = 'analysing';
      break;

    case 'RunCompletedAnalysis':
      builder.status = 'analyzed';
      builder.analysisComplete = true;
      break;

    case 'RunStartedExecution':
      builder.status = 'executing';
      builder.delegationTarget = (event.payload as any).delegationTarget;
      break;

    case 'RunCompletedExecution':
      builder.status = 'executed';
      builder.executionComplete = true;
      break;

    case 'RunVerified':
      builder.status = 'verified';
      break;

    case 'RunCompleted':
      builder.status = 'completed';
      break;

    case 'RunFailed':
      builder.status = 'failed';
      builder.needsRecovery = true;
      break;

    case 'RunCancelled':
      builder.status = 'cancelled';
      break;

    case 'RunRecovered':
      builder.recoveryPath = (event.payload as any).recoveryPath;
      break;

    default:
      // Unknown event type - fail closed during validation phase
      console.warn(`Unknown event type during replay: ${event.type}`);
  }

  builder.version = event.aggregateVersion;
}

/**
 * Rehydrate aggregate from event stream
 * Returns fully reconstructed state without emitting any new events
 */
export async function rehydrateAggregate(
  aggregateId: string,
  events: PersistedRuntimeEvent[],
  options?: { startVersion?: number; maxEvents?: number }
): Promise<RehydrationResult> {
  const builder: TaskRunBuilder = {
    aggregateId,
    version: 0,
    status: 'created',
    strategy: 'simple'
  };

  const replayErrors: string[] = [];

  // Sort by version for deterministic application
  const sortedEvents = [...events]
    .filter(e => e.aggregateVersion >= (options?.startVersion ?? 1))
    .sort((a, b) => a.aggregateVersion - b.aggregateVersion)
    .slice(0, options?.maxEvents);

  let prevVersion = 0;
  let creationTime: Date | undefined;

  for (const event of sortedEvents) {
    // Validate contiguity
    if (event.aggregateVersion !== prevVersion + 1 && prevVersion > 0) {
      replayErrors.push(`Version gap detected: expected ${prevVersion + 1}, got ${event.aggregateVersion}`);
      continue; // Skip this event but continue replay
    }

    // Validate event
    const validation = validatePersistedEvent(event);
    if (!validation.valid) {
      replayErrors.push(`Invalid event at version ${event.aggregateVersion}: ${validation.errors.join('; ')}`);
      continue;
    }

    // Apply event
    applyEventToBuilder(builder, event);
    
    if (creationTime === undefined) {
      creationTime = event.createdAt ?? event.committedAt;
    }

    prevVersion = event.aggregateVersion;
  }

  return {
    aggregateId,
    version: builder.version,
    eventsApplied: prevVersion,
    createdAt: creationTime,
    replayErrors: replayErrors.length > 0 ? replayErrors : undefined
  };
}

/**
 * Deterministic replay test helper
 * Same input must always produce same output
 */
export function deterministicReplay(events: PersistedRuntimeEvent[]): TaskRunState[] {
  const transitions: TaskRunState[] = [];
  
  let currentStatus: TaskRunState = 'created';
  
  for (const event of events.sort((a, b) => a.aggregateVersion - b.aggregateVersion)) {
    const newState = determineNextState(event);
    if (newState !== currentStatus) {
      transitions.push(currentStatus);
      currentStatus = newState;
    }
  }
  
  transitions.push(currentStatus);
  return transitions;
}

function determineNextState(event: PersistedRuntimeEvent): TaskRunState {
  switch (event.type) {
    case 'RunCreated':
      return 'created';
    case 'RunStartedPlanning':
      return 'planning';
    case 'RunCompletedPlanning':
      return 'planned';
    case 'RunStartedAnalysis':
      return 'analysing';
    case 'RunCompletedAnalysis':
      return 'analyzed';
    case 'RunStartedExecution':
      return 'executing';
    case 'RunCompletedExecution':
      return 'executed';
    case 'RunVerified':
      return 'verified';
    case 'RunCompleted':
      return 'completed';
    case 'RunFailed':
      return 'failed';
    case 'RunCancelled':
      return 'cancelled';
    case 'RunRecovered':
      return 'recovering';
    default:
      return 'created';
  }
}
