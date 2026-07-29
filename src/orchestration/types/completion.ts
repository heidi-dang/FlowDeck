import { z } from "zod/v4";

export const CompletionStatus = {
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type CompletionStatus = (typeof CompletionStatus)[keyof typeof CompletionStatus];

export interface Completion {
  id: string;
  runId: string;
  status: CompletionStatus;
  correlationId: string;
  causationId?: string;
  summary?: string;
  outcome?: "success" | "failure" | "partial";
  assignmentResults?: unknown[];
  artifacts?: Record<string, unknown>[];
  metrics?: Record<string, number>;
  metadata?: Record<string, unknown>;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCompletionInput {
  runId: string;
  correlationId: string;
  causationId?: string;
  outcome?: "success" | "failure" | "partial";
  assignmentResults?: unknown[];
  summary?: string;
  artifacts?: Record<string, unknown>[];
  metrics?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export interface UpdateCompletionInput {
  status?: CompletionStatus;
  summary?: string;
  outcome?: "success" | "failure" | "partial";
  assignmentResults?: unknown[];
  artifacts?: Record<string, unknown>[];
  metrics?: Record<string, number>;
  metadata?: Record<string, unknown>;
  completedAt?: string;
}

export interface CompletionDTO {
  id: string;
  runId: string;
  status: string;
  correlationId: string;
  summary?: string;
  completedAt?: string;
  createdAt: string;
}

export const CreateCompletionInputSchema = z.object({
  runId: z.string().min(1).max(255),
  correlationId: z.string().min(1).max(255),
  causationId: z.string().max(255).optional(),
  outcome: z.enum(["success", "failure", "partial"]).optional(),
  assignmentResults: z.array(z.any()).optional(),
  summary: z.string().max(10000).optional(),
  artifacts: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
  metrics: z.record(z.string(), z.number()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
