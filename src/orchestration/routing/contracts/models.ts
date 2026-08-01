/**
 * Routing contract: model tier selection.
 *
 * Tiers are ordered weakest -> strongest. Routing picks the cheapest tier
 * that still meets the capability floor required by the task. The floor is
 * expressed as a list of canonical capabilities (document section 7.2)
 * mapped to a minimum tier through the routing-owned CAPABILITY_TIER_FLOOR
 * projection (document section 10.3).
 */

import { z } from "zod"
import type { Capability } from "./agents"
import {
  type ExecutionStrategy,
  type TaskClass,
  zExecutionStrategy,
  zNonEmptyId,
  zTaskClass,
  zTaskScores,
  type TaskScores,
} from "./task"

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

/**
 * Routing-owned projection mapping each canonical capability (document
 * section 7.2) to the minimum tier that can satisfy it (document section
 * 10.2 use lists). This projection lives in the routing domain; the
 * canonical registry in src/services is never modified.
 */
export const CAPABILITY_TIER_FLOOR: Record<string, ModelTier> = {
  "repository inspection": "general_coding",
  "GitHub inspection": "small_fast",
  "CI log inspection": "small_fast",
  "FDX index inspection": "small_fast",
  "code mutation": "general_coding",
  "UI implementation": "general_coding",
  "security audit": "strong_reasoning",
  "database migration": "strong_reasoning",
  "release operation": "strong_reasoning",
  "package publication": "strong_reasoning",
  "destructive Git": "strong_reasoning",
  "infrastructure change": "strong_reasoning",
  // Strategy-required capabilities (document section 6.2) — recognized so
  // StrategyPolicy.requiredCapabilities validate against the projection.
  planning: "general_coding",
  ownership_leases: "general_coding",
  read_only: "small_fast",
  independent_review: "strong_reasoning",
}

/** Returns true when `value` is one of the canonical model tiers. */
export function isValidModelTier(value: unknown): value is ModelTier {
  return (MODEL_TIERS as readonly unknown[]).includes(value)
}

/** Returns true when `tier` is at least as strong as `floor`. */
export function tierMeetsFloor(tier: ModelTier, floor: ModelTier): boolean {
  return MODEL_TIER_RANK[tier] >= MODEL_TIER_RANK[floor]
}

/**
 * Returns true when `tier` can satisfy every capability in `floor`.
 * An empty floor is satisfied by any tier; a capability outside the
 * CAPABILITY_TIER_FLOOR projection can never be satisfied.
 */
export function tierMeetsCapabilityFloor(tier: ModelTier, floor: Capability[]): boolean {
  return floor.every((capability) => {
    const required = CAPABILITY_TIER_FLOOR[capability]
    return required !== undefined && MODEL_TIER_RANK[tier] >= MODEL_TIER_RANK[required]
  })
}

/** Timeout posture for a model call (document section 10.3). */
export interface TimeoutPolicy {
  queueMs: number
  firstTokenMs: number
  totalMs: number
}

/** Inputs the model router uses to select a tier (document section 10.3). */
export interface ModelRoutingInput {
  taskId: string
  taskClass: TaskClass
  scores: TaskScores
  capabilityFloor: Capability[]
  strategy: ExecutionStrategy
  timeoutPolicy: TimeoutPolicy
  /** Provider health scores 0-100 (document section 12). */
  providerHealth?: Record<string, number>
}

/**
 * The model router's selection verdict (document section 10.3).
 * Cross-field invariants enforced by zModelSelectionDecision:
 * - the selected tier satisfies every capability in `capabilityFloor`;
 * - `fallbackTiers` are strictly ordered strongest-first, never duplicated,
 *   and never fall below the capability floor.
 */
export interface ModelSelectionDecision {
  tier: ModelTier
  provider?: string
  model?: string
  confidence: number
  reasonCodes: string[]
  fallbackTiers: ModelTier[]
  timeoutPolicy: TimeoutPolicy
  capabilityFloor: Capability[]
}

/** Zod schema for a ModelTier value. */
export const zModelTier = z.enum(MODEL_TIERS)

/** Zod schema for a TimeoutPolicy; every bound is a non-negative integer. */
export const zTimeoutPolicy = z.object({
  queueMs: z.number().int().min(0),
  firstTokenMs: z.number().int().min(0),
  totalMs: z.number().int().min(0),
})

/** Zod schema for ModelRoutingInput (document section 10.3 shape). */
export const zModelRoutingInput = z
  .object({
    taskId: zNonEmptyId,
    taskClass: zTaskClass,
    scores: zTaskScores,
    capabilityFloor: z.array(zNonEmptyId),
    strategy: zExecutionStrategy,
    timeoutPolicy: zTimeoutPolicy,
    providerHealth: z.record(z.string(), z.number().min(0).max(100)).optional(),
  })
  .superRefine((input, ctx) => {
    for (const capability of input.capabilityFloor) {
      if (CAPABILITY_TIER_FLOOR[capability] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilityFloor"],
          message: `unknown capability in floor: ${capability}`,
        })
      }
    }
  })

/** Zod schema for a ModelSelectionDecision with cross-field invariant checks. */
export const zModelSelectionDecision = z
  .object({
    tier: zModelTier,
    provider: z.string().optional(),
    model: z.string().optional(),
    confidence: z.number().min(0).max(100),
    reasonCodes: z.array(zNonEmptyId).min(1, "reasonCodes must be non-empty"),
    fallbackTiers: z.array(zModelTier),
    timeoutPolicy: zTimeoutPolicy,
    capabilityFloor: z.array(zNonEmptyId),
  })
  .superRefine((d, ctx) => {
    for (const capability of d.capabilityFloor) {
      if (CAPABILITY_TIER_FLOOR[capability] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilityFloor"],
          message: `unknown capability in floor: ${capability}`,
        })
      }
    }
    if (!tierMeetsCapabilityFloor(d.tier, d.capabilityFloor)) {
      ctx.addIssue({
        code: "custom",
        path: ["tier"],
        message: "selected tier does not meet the capability floor",
      })
    }
    const seen = new Set<string>()
    for (const tier of d.fallbackTiers) {
      if (seen.has(tier)) {
        ctx.addIssue({
          code: "custom",
          path: ["fallbackTiers"],
          message: "fallback tiers must not contain duplicates",
        })
        break
      }
      seen.add(tier)
    }
    for (let i = 1; i < d.fallbackTiers.length; i += 1) {
      if (MODEL_TIER_RANK[d.fallbackTiers[i]] >= MODEL_TIER_RANK[d.fallbackTiers[i - 1]]) {
        ctx.addIssue({
          code: "custom",
          path: ["fallbackTiers"],
          message: "fallback tiers must be strictly ordered strongest-first",
        })
        break
      }
    }
    for (const tier of d.fallbackTiers) {
      if (!tierMeetsCapabilityFloor(tier, d.capabilityFloor)) {
        ctx.addIssue({
          code: "custom",
          path: ["fallbackTiers"],
          message: "fallback tier falls below the capability floor",
        })
        break
      }
    }
  })

/** Returns true when `value` is a structurally valid ModelSelectionDecision. */
export function isModelSelectionDecision(value: unknown): boolean {
  return zModelSelectionDecision.safeParse(value).success
}
