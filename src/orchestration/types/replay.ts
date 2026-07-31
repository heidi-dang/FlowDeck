import { z } from "zod/v4";
import type { OrchestrationEvent } from "./events";

export const ReplayStatus = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type ReplayStatus = (typeof ReplayStatus)[keyof typeof ReplayStatus];

export interface Replay {
  id: string;
  sourceRunId: string;
  status: ReplayStatus;
  correlationId: string;
  causationId?: string;
  eventCount?: number;
  processedCount?: number;
  failedCount?: number;
  reason?: string;
  events?: OrchestrationEvent[];
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateReplayInput {
  sourceRunId: string;
  correlationId: string;
  causationId?: string;
  reason?: string;
  events?: OrchestrationEvent[];
  metadata?: Record<string, unknown>;
}

export interface ReplayDTO {
  id: string;
  sourceRunId: string;
  status: string;
  correlationId: string;
  reason?: string;
  createdAt: string;
  completedAt?: string;
}

export const CreateReplayInputSchema = z.object({
  sourceRunId: z.string().min(1).max(255),
  correlationId: z.string().min(1).max(255),
  causationId: z.string().max(255).optional(),
  reason: z.string().max(2000).optional(),
  events: z.array(z.any()).max(1000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
