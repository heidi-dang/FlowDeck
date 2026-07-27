import { z } from "zod/v4";
import { CollectorNameEnum } from "./common";

export const StartRunRequestSchema = z.object({
  mode: z.enum(["full", "quick"]),
  sourceRevision: z.string().optional().default("current"),
  collectors: z.array(CollectorNameEnum).optional(),
}).strict();

export const StartRunResponseSchema = z.object({
  accepted: z.boolean(),
  runId: z.string().optional(),
  error: z.string().optional(),
}).strict();

export const CancelRunResponseSchema = z.object({
  accepted: z.boolean(),
  error: z.string().optional(),
}).strict();

export const BatchPlanFixRequestSchema = z.object({
  findingIds: z.array(z.string().min(1)).min(1),
}).strict();

export const BatchPlanFixItemSchema = z.object({
  findingId: z.string().min(1),
  accepted: z.boolean(),
  repairSessionId: z.string().optional(),
  error: z.string().optional(),
}).strict();

export const BatchPlanFixResponseSchema = z.object({
  accepted: z.boolean(),
  results: z.array(BatchPlanFixItemSchema),
}).strict();

export const BatchIgnoreRequestSchema = z.object({
  findingIds: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
}).strict();

export const BatchIgnoreItemSchema = z.object({
  findingId: z.string().min(1),
  accepted: z.boolean(),
  error: z.string().optional(),
}).strict();

export const BatchIgnoreResponseSchema = z.object({
  accepted: z.boolean(),
  results: z.array(BatchIgnoreItemSchema),
}).strict();

export const BatchVerifyRequestSchema = z.object({
  findingIds: z.array(z.string().min(1)).min(1),
}).strict();

export const BatchVerifyItemSchema = z.object({
  findingId: z.string().min(1),
  accepted: z.boolean(),
  error: z.string().optional(),
}).strict();

export const BatchVerifyResponseSchema = z.object({
  accepted: z.boolean(),
  results: z.array(BatchVerifyItemSchema),
}).strict();

export const AvailabilityResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
}).strict();

export const ApiErrorSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1),
  statusCode: z.number().int().positive(),
  details: z.unknown().optional(),
}).strict();