import { z } from "zod/v4";

export const OrchestrationEventType = {
  RUN_CREATED: "run.created",
  RUN_QUEUED: "run.queued",
  RUN_STARTED: "run.started",
  RUN_COMPLETED: "run.completed",
  RUN_FAILED: "run.failed",
  RUN_CANCELLED: "run.cancelled",
  RUN_PAUSED: "run.paused",
  RUN_RESUMED: "run.resumed",
  RUN_PROGRESS: "run.progress",
  CONTRACT_CREATED: "contract.created",
  CONTRACT_UPDATED: "contract.updated",
  CONTRACT_COMPLETED: "contract.completed",
  CONTRACT_FAILED: "contract.failed",
  ASSIGNMENT_CREATED: "assignment.created",
  ASSIGNMENT_ASSIGNED: "assignment.assigned",
  ASSIGNMENT_STARTED: "assignment.started",
  ASSIGNMENT_COMPLETED: "assignment.completed",
  ASSIGNMENT_FAILED: "assignment.failed",
  ASSIGNMENT_CANCELLED: "assignment.cancelled",
  VERIFICATION_CREATED: "verification.created",
  VERIFICATION_STARTED: "verification.started",
  VERIFICATION_COMPLETED: "verification.completed",
  VERIFICATION_PASSED: "verification.passed",
  VERIFICATION_FAILED: "verification.failed",
  COMPLETION_CREATED: "completion.created",
  COMPLETION_STARTED: "completion.started",
  COMPLETION_COMPLETED: "completion.completed",
  REPLAY_CREATED: "replay.created",
  REPLAY_STARTED: "replay.started",
  REPLAY_COMPLETED: "replay.completed",
  REPLAY_FAILED: "replay.failed",
  COMMAND_DISPATCHED: "command.dispatched",
  COMMAND_COMPLETED: "command.completed",
  COMMAND_FAILED: "command.failed",
  OUTBOX_ENTRY_CREATED: "outbox.entry.created",
  OUTBOX_ENTRY_DELIVERED: "outbox.entry.delivered",
  OUTBOX_ENTRY_FAILED: "outbox.entry.failed",
  ERROR_OCCURRED: "error.occurred",
} as const;

export type OrchestrationEventType = (typeof OrchestrationEventType)[keyof typeof OrchestrationEventType];

export const EVENT_VERSION = 1;

/** Full domain event with complete metadata for replay and distributed tracing. */
export interface OrchestrationEvent {
  /** Unique event identifier (UUID). */
  id: string;
  /** Event type string, e.g. "run.created". */
  type: string;
  /** Schema version — increment when event shape changes. Consumers MUST reject unknown versions. */
  eventVersion: number;
  /** ISO-8601 timestamp of when the event occurred. */
  timestamp: string;
  /** Correlation ID tracing the logical operation across service boundaries. */
  correlationId: string;
  /** Causation ID — the immediate parent event that caused this event. */
  causationId?: string;
  /** Aggregate root ID (e.g. run ID, contract ID). */
  aggregateId?: string;
  /** Monotonic version of the aggregate at the time this event was recorded. */
  aggregateVersion?: number;
  /** Session ID running this orchestration (optional — populated when within a user session). */
  sessionId?: string;
  /** Agent that performed the action (optional). */
  agentId?: string;
  /** Related run ID. */
  runId?: string;
  /** Related assignment ID. */
  assignmentId?: string;
  /** Related contract ID. */
  contractId?: string;
  /** Event payload — MUST be plain JSON-serializable data. */
  data: Record<string, unknown>;
  /** System metadata (source, trace headers, etc.) — MUST be plain JSON. */
  metadata: Record<string, unknown>;
}

/** Event filter for querying stored events. */
export interface EventFilter {
  type?: string;
  correlationId?: string;
  runId?: string;
  since?: string;
  until?: string;
}

/** Public DTO — safe for API and SSE consumption. Never leaks internal event representation. */
export interface OrchestrationEventDTO {
  id: string;
  type: string;
  eventVersion: number;
  timestamp: string;
  correlationId: string;
  runId?: string;
  causationId?: string;
  aggregateId?: string;
}

export interface EventSubscriber {
  id: string;
  handler: (event: OrchestrationEvent) => void | Promise<void>;
  filter?: { types?: string[]; runId?: string };
  onError?: (error: Error, event: OrchestrationEvent) => void;
}

export const EventFilterSchema = z.object({
  type: z.string().optional(),
  correlationId: z.string().optional(),
  runId: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

/** Helper to create a properly structured event with all required metadata. */
export function createEvent(
  type: string,
  fields: {
    correlationId: string;
    causationId?: string;
    aggregateId?: string;
    aggregateVersion?: number;
    sessionId?: string;
    agentId?: string;
    runId?: string;
    assignmentId?: string;
    contractId?: string;
    data?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): OrchestrationEvent {
  return {
    id: crypto.randomUUID(),
    type,
    eventVersion: EVENT_VERSION,
    timestamp: new Date().toISOString(),
    correlationId: fields.correlationId,
    causationId: fields.causationId,
    aggregateId: fields.aggregateId,
    aggregateVersion: fields.aggregateVersion,
    sessionId: fields.sessionId,
    agentId: fields.agentId,
    runId: fields.runId,
    assignmentId: fields.assignmentId,
    contractId: fields.contractId,
    data: fields.data ?? {},
    metadata: fields.metadata ?? {},
  };
}
