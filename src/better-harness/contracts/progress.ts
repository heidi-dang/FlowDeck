import { z } from "zod/v4";
import { HarnessRunStatusEnum } from "./common";

export const HarnessRunProgressSchema = z.object({
  runId: z.string().min(1),
  status: HarnessRunStatusEnum,
  stage: z.string().optional(),
  progressPercent: z.number().min(0).max(100).optional(),
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  estimatedTimeRemainingSeconds: z.number().nonnegative().optional(),
  errorMessage: z.string().optional(),
}).strict();
export type HarnessRunProgress = z.infer<typeof HarnessRunProgressSchema>;
