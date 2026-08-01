/**
 * Routing contract: model tier selection.
 *
 * Tiers are ordered weakest -> strongest. Routing picks the cheapest tier
 * that still meets the capability floor required by the task.
 */

import { type TaskClass, zTaskClass } from "./task"
import { z } from "zod"

/** Ordered model capability tiers. */
export type ModelTier = "small_fast" | "general_coding" | "strong_reasoning"

/** Every model tier, ordered weakest to strongest. */
export const MODEL_TIERS = [
  "small_fast",
  "general_coding",
  "strong_reasoning",
] as const satisfies readonly ModelTier[]

/** Numeric rank of each tier; higher means stronger capability. */
export const MODEL_TIER_RANK: Record<ModelTier, number> = {
  small_fast: 0,
  general_coding: 1,
  strong_reasoning: 2,
}

/** Returns true when `value` is one of the canonical model tiers. */
export function isValidModelTier(value: unknown): value is ModelTier {
  return (MODEL_TIERS as readonly unknown[]).includes(value)
}

/** Returns true when `tier` is at least as strong as `floor`. */
export function tierMeetsFloor(tier: ModelTier, floor: ModelTier): boolean {
  return MODEL_TIER_RANK[tier] >= MODEL_TIER_RANK[floor]
}

/** Inputs the model router uses to select a tier. */
export interface ModelRoutingInput {
  taskClass: TaskClass
  complexity: number
  ambiguity: number
  risk: number
  contextTokens: number
  historicalSuccessRate?: number
  expectedOutputTokens: number
  latencyPriority: number
  costPriority: number
  requiredCapabilities: string[]
}

/** The model router's selection verdict. */
export interface ModelSelectionDecision {
  tier: ModelTier
  provider?: string
  model?: string
  confidence: number
  reasonCodes: string[]
  fallbackTiers: ModelTier[]
  timeoutPolicy: string
  capabilityFloor: ModelTier
}

/** Zod schema for a ModelTier value. */
export const zModelTier = z.enum(MODEL_TIERS)

/** Zod schema for ModelRoutingInput; bounded 0-100 scales, 0-1 success rate. */
export const zModelRoutingInput = z.object({
  taskClass: zTaskClass,
  complexity: z.number().min(0).max(100),
  ambiguity: z.number().min(0).max(100),
  risk: z.number().min(0).max(100),
  contextTokens: z.number().min(0),
  historicalSuccessRate: z.number().min(0).max(1).optional(),
  expectedOutputTokens: z.number().min(0),
  latencyPriority: z.number().min(0).max(100),
  costPriority: z.number().min(0).max(100),
  requiredCapabilities: z.array(z.string()),
})

/** Zod schema for a ModelSelectionDecision. */
export const zModelSelectionDecision = z.object({
  tier: zModelTier,
  provider: z.string().optional(),
  model: z.string().optional(),
  confidence: z.number().min(0).max(100),
  reasonCodes: z.array(z.string()),
  fallbackTiers: z.array(zModelTier),
  timeoutPolicy: z.string(),
  capabilityFloor: zModelTier,
})

/** Returns true when `value` is a structurally valid ModelSelectionDecision. */
export function isModelSelectionDecision(value: unknown): boolean {
  return zModelSelectionDecision.safeParse(value).success
}
