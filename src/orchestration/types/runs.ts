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
