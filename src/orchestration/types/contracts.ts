import { z } from "zod/v4";

export const ContractStatus = {
  ACTIVE: "active",
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type ContractStatus = (typeof ContractStatus)[keyof typeof ContractStatus];

export interface Contract {
  id: string;
  name: string;
  status: ContractStatus;
  correlationId: string;
  causationId?: string;
  runId?: string;
  assignmentId?: string;
  description?: string;
  version?: string;
  rules?: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateContractInput {
  name: string;
  correlationId: string;
  causationId?: string;
  runId?: string;
  assignmentId?: string;
  description?: string;
  version?: string;
  rules?: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface UpdateContractInput {
  status?: string;
  name?: string;
  description?: string;
  version?: string;
  rules?: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface ContractFilter {
  status?: string;
  name?: string;
  correlationId?: string;
  tags?: string[];
}

export interface ContractDTO {
  id: string;
  name: string;
  status: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

export const CreateContractInputSchema = z.object({
  name: z.string().min(1).max(255),
  correlationId: z.string().min(1).max(255),
  causationId: z.string().max(255).optional(),
  runId: z.string().max(255).optional(),
  assignmentId: z.string().max(255).optional(),
  description: z.string().max(2000).optional(),
  version: z.string().max(50).optional(),
  rules: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
});

export const UpdateContractInputSchema = z.object({
  status: z.enum([ContractStatus.ACTIVE, ContractStatus.PENDING, ContractStatus.COMPLETED, ContractStatus.FAILED, ContractStatus.CANCELLED]).optional(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  version: z.string().max(50).optional(),
  rules: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
});

export const ContractFilterSchema = z.object({
  status: z.string().optional(),
  name: z.string().optional(),
  correlationId: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
