import { z } from "zod/v4";

export const AssignmentStatus = {
  PENDING: "pending",
  ASSIGNED: "assigned",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;

export type AssignmentStatus = (typeof AssignmentStatus)[keyof typeof AssignmentStatus];

export interface Assignment {
  id: string;
  runId: string;
  agentId: string;
  role: string;
  status: AssignmentStatus;
  correlationId: string;
  causationId?: string;
  contractId?: string;
  taskDescription?: string;
  task?: string;
  tools?: string[];
  context?: Record<string, unknown>;
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssignmentInput {
  runId: string;
  agentId: string;
  role: string;
  correlationId: string;
  causationId?: string;
  contractId?: string;
  taskDescription?: string;
  task?: string;
  tools?: string[];
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface UpdateAssignmentInput {
  status?: string;
  task?: string;
  tools?: string[];
  context?: Record<string, unknown>;
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AssignmentFilter {
  runId?: string;
  agentId?: string;
  role?: string;
  status?: string;
  correlationId?: string;
}

export interface AssignmentDTO {
  id: string;
  runId: string;
  agentId: string;
  role: string;
  status: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

export const CreateAssignmentInputSchema = z.object({
  runId: z.string().min(1).max(255),
  agentId: z.string().min(1).max(255),
  role: z.string().min(1).max(100),
  correlationId: z.string().min(1).max(255),
  causationId: z.string().max(255).optional(),
  contractId: z.string().max(255).optional(),
  taskDescription: z.string().max(5000).optional(),
  task: z.string().max(5000).optional(),
  tools: z.array(z.string().max(255)).max(100).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateAssignmentInputSchema = z.object({
  status: z.enum([AssignmentStatus.PENDING, AssignmentStatus.ASSIGNED, AssignmentStatus.IN_PROGRESS, AssignmentStatus.COMPLETED, AssignmentStatus.FAILED, AssignmentStatus.SKIPPED]).optional(),
  task: z.string().max(5000).optional(),
  tools: z.array(z.string().max(255)).max(100).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const AssignmentFilterSchema = z.object({
  runId: z.string().optional(),
  agentId: z.string().optional(),
  role: z.string().optional(),
  status: z.string().optional(),
  correlationId: z.string().optional(),
});
