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
  COMMAND_DISPATCHED: "command.dispatched",
  COMMAND_COMPLETED: "command.completed",
  COMMAND_FAILED: "command.failed",
  OUTBOX_ENTRY_CREATED: "outbox.entry.created",
  OUTBOX_ENTRY_DELIVERED: "outbox.entry.delivered",
  OUTBOX_ENTRY_FAILED: "outbox.entry.failed",
  ERROR_OCCURRED: "error.occurred",
} as const;

export type OrchestrationEventType = (typeof OrchestrationEventType)[keyof typeof OrchestrationEventType];

export interface OrchestrationEvent {
  id: string;
  type: string;
  timestamp: string;
  correlationId: string;
  causationId?: string;
  aggregateId?: string;
  runId?: string;
  assignmentId?: string;
  contractId?: string;
  sessionId?: string;
  agentId?: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface EventFilter {
  type?: string;
  correlationId?: string;
  runId?: string;
  since?: string;
  until?: string;
}

export interface OrchestrationEventDTO {
  id: string;
  type: string;
  timestamp: string;
  correlationId: string;
  runId?: string;
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
