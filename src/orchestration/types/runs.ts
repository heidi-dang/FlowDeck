import { z } from "zod/v4";

export const RunStatus = {
  QUEUED: "queued",
  PENDING: "pending",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.TIMEOUT,
]);

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Persisted orchestration phases in task_runs.state.
 * These are internal phases, not the public RunStatus.
 */
export const OrchestrationPhase = {
  CREATED: "created",
  PLANNING: "planning",
  ANALYSING: "analysing",
  DELEGATING: "delegating",
  EXECUTING: "executing",
  VERIFYING: "verifying",
  RECOVERING: "recovering",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type OrchestrationPhase = (typeof OrchestrationPhase)[keyof typeof OrchestrationPhase];

/**
 * All valid persisted phases.
 */
export const VALID_PERSISTED_PHASES: ReadonlySet<OrchestrationPhase> = new Set([
  OrchestrationPhase.CREATED,
  OrchestrationPhase.PLANNING,
  OrchestrationPhase.ANALYSING,
  OrchestrationPhase.DELEGATING,
  OrchestrationPhase.EXECUTING,
  OrchestrationPhase.VERIFYING,
  OrchestrationPhase.RECOVERING,
  OrchestrationPhase.COMPLETED,
  OrchestrationPhase.FAILED,
  OrchestrationPhase.CANCELLED,
]);

/**
 * Maps public RunStatus to persisted OrchestrationPhase.
 * Throws if the status cannot be durably represented.
 */
export function mapRunStatusToTaskRunState(status: RunStatus): OrchestrationPhase {
  switch (status) {
    case RunStatus.QUEUED:
      return OrchestrationPhase.CREATED;
    case RunStatus.PENDING:
      return OrchestrationPhase.CREATED;
    case RunStatus.RUNNING:
      return OrchestrationPhase.EXECUTING;
    case RunStatus.PAUSED:
      // paused is not a valid persisted phase - fail closed
      throw new Error(`RUN_STATUS_TRANSITION_INVALID: RunStatus.paused cannot be durably represented as a persisted phase. Use recovery or cancellation instead.`);
    case RunStatus.COMPLETED:
      return OrchestrationPhase.COMPLETED;
    case RunStatus.FAILED:
      return OrchestrationPhase.FAILED;
    case RunStatus.CANCELLED:
      return OrchestrationPhase.CANCELLED;
    case RunStatus.TIMEOUT:
      // timeout is not a valid persisted phase - fail closed
      throw new Error(`RUN_STATUS_TRANSITION_INVALID: RunStatus.timeout cannot be durably represented as a persisted phase. Use failure with timeout metadata instead.`);
    default:
      // Exhaustive check - should never reach here if all RunStatus values are handled
      const exhaustiveCheck: never = status;
      throw new Error(`Unhandled RunStatus: ${exhaustiveCheck}`);
  }
}

/**
 * Maps persisted OrchestrationPhase back to public RunStatus.
 * Uses exhaustive switch - all valid phases must be handled.
 */
export function mapTaskRunStateToRunStatus(phase: string): RunStatus {
  switch (phase) {
    case OrchestrationPhase.CREATED:
      return RunStatus.PENDING;
    case OrchestrationPhase.PLANNING:
      return RunStatus.RUNNING;
    case OrchestrationPhase.ANALYSING:
      return RunStatus.RUNNING;
    case OrchestrationPhase.DELEGATING:
      return RunStatus.RUNNING;
    case OrchestrationPhase.EXECUTING:
      return RunStatus.RUNNING;
    case OrchestrationPhase.VERIFYING:
      return RunStatus.RUNNING;
    case OrchestrationPhase.RECOVERING:
      return RunStatus.RUNNING;
    case OrchestrationPhase.COMPLETED:
      return RunStatus.COMPLETED;
    case OrchestrationPhase.FAILED:
      return RunStatus.FAILED;
    case OrchestrationPhase.CANCELLED:
      return RunStatus.CANCELLED;
    default:
      // Invalid persisted phase - fail closed
      throw new Error(`INVALID_PERSISTED_PHASE: "${phase}" is not a valid persisted orchestration phase.`);
  }
}

/**
 * Validates that a string is a valid RunStatus.
 */
export function isValidRunStatus(status: string): status is RunStatus {
  return Object.values(RunStatus).includes(status as RunStatus);
}

/**
 * Validates that a string is a valid persisted phase.
 */
export function isValidPersistedPhase(phase: string): phase is OrchestrationPhase {
  return VALID_PERSISTED_PHASES.has(phase as OrchestrationPhase);
}

export interface Run {
  id: string;
  status: RunStatus;
  runType: string;
  correlationId: string;
  causationId?: string;
  sessionId?: string;
  agentId?: string;
  aggregateId?: string;
  contractId?: string;
  assignmentId?: string;
  stage?: string;
  progress?: number;
  progressPercent?: number;
  error?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CreateRunInput {
  runType: string;
  correlationId: string;
  causationId?: string;
  sessionId?: string;
  agentId?: string;
  aggregateId?: string;
  contractId?: string;
  assignmentId?: string;
  stage?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface UpdateRunInput {
  status?: string;
  stage?: string;
  progress?: number;
  progressPercent?: number;
  error?: string;
  errorMessage?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tags?: string[];
  startedAt?: string;
  completedAt?: string;
}

export interface RunFilter {
  status?: string;
  runType?: string;
  correlationId?: string;
  tags?: string[];
  createdAfter?: string;
  createdBefore?: string;
}

export interface RunDTO {
  id: string;
  status: RunStatus;
  runType: string;
  correlationId: string;
  stage?: string;
  createdAt: string;
  updatedAt: string;
}

export const CreateRunInputSchema = z.object({
  runType: z.string().min(1).max(255),
  correlationId: z.string().min(1).max(255),
  causationId: z.string().max(255).optional(),
  sessionId: z.string().max(255).optional(),
  agentId: z.string().max(255).optional(),
  aggregateId: z.string().max(255).optional(),
  contractId: z.string().max(255).optional(),
  assignmentId: z.string().max(255).optional(),
  stage: z.string().max(255).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
});

export const UpdateRunInputSchema = z.object({
  status: z.enum([
    RunStatus.PENDING, RunStatus.RUNNING, RunStatus.PAUSED,
    RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.TIMEOUT,
  ]).optional(),
  stage: z.string().max(255).optional(),
  progress: z.number().min(0).max(100).optional(),
  error: z.string().max(5000).optional(),
  errorMessage: z.string().max(5000).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});

export const RunFilterSchema = z.object({
  status: z.string().optional(),
  runType: z.string().optional(),
  correlationId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
});
