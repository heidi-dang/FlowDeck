/**
 * Routing contract: execution strategy policies.
 *
 * A strategy bundles the execution posture (how many specialists, which
 * pipeline stages, verification depth, model tier) for a routed task. The
 * canonical strategy vocabulary lives here, in the routing domain namespace;
 * it is unrelated to the legacy execution strategy in the current harness.
 */

import { z } from "zod"
import type { ModelTier } from "./models"
import { zModelTier } from "./models"

/** The five pipeline stages a strategy may be allowed to operate in. */
export type RunStage = "task" | "review" | "execute" | "verify" | "done"

/** Canonical execution strategies understood by the routing layer. */
export type ExecutionStrategy =
  | "fast_direct"
  | "direct_verified"
  | "explore_then_execute"
  | "planned_execution"
  | "parallel_implementation"
  | "root_cause_repair"
  | "audit_only"
  | "repair_and_independent_audit"
  | "recovery_resume"

/** Every canonical execution strategy, in a stable order. */
export const EXECUTION_STRATEGIES = [
  "fast_direct",
  "direct_verified",
  "explore_then_execute",
  "planned_execution",
  "parallel_implementation",
  "root_cause_repair",
  "audit_only",
  "repair_and_independent_audit",
  "recovery_resume",
] as const satisfies readonly ExecutionStrategy[]

/** Verification depth requested for a strategy. */
export type VerificationLevel = "focused" | "standard" | "full" | "release"

/** Returns true when `value` is one of the canonical execution strategies. */
export function isValidExecutionStrategy(value: unknown): value is ExecutionStrategy {
  return (EXECUTION_STRATEGIES as readonly unknown[]).includes(value)
}

/** Runtime posture that governs how a routed task is executed. */
export interface StrategyPolicy {
  strategy: ExecutionStrategy
  allowedStates: RunStage[]
  maximumSpecialists: number
  requiredCapabilities: string[]
  requiredReviewers: number
  verificationLevel: VerificationLevel
  contextBudget: number
  modelTier: ModelTier
  recoveryLimit: number
  approvalRequirements: string[]
}

/** Deterministic default policies, one per canonical execution strategy. */
export const DEFAULT_STRATEGY_POLICIES: Record<ExecutionStrategy, StrategyPolicy> = {
  fast_direct: {
    strategy: "fast_direct",
    allowedStates: ["execute"],
    maximumSpecialists: 0,
    requiredCapabilities: [],
    requiredReviewers: 0,
    verificationLevel: "focused",
    contextBudget: 8000,
    modelTier: "small_fast",
    recoveryLimit: 1,
    approvalRequirements: [],
  },
  direct_verified: {
    strategy: "direct_verified",
    allowedStates: ["execute", "verify"],
    maximumSpecialists: 0,
    requiredCapabilities: [],
    requiredReviewers: 0,
    verificationLevel: "standard",
    contextBudget: 16000,
    modelTier: "general_coding",
    recoveryLimit: 2,
    approvalRequirements: [],
  },
  explore_then_execute: {
    strategy: "explore_then_execute",
    allowedStates: ["task", "execute"],
    maximumSpecialists: 1,
    requiredCapabilities: [],
    requiredReviewers: 0,
    verificationLevel: "standard",
    contextBudget: 24000,
    modelTier: "general_coding",
    recoveryLimit: 2,
    approvalRequirements: [],
  },
  planned_execution: {
    strategy: "planned_execution",
    allowedStates: ["task", "execute", "verify"],
    maximumSpecialists: 2,
    requiredCapabilities: ["planning"],
    requiredReviewers: 1,
    verificationLevel: "full",
    contextBudget: 32000,
    modelTier: "general_coding",
    recoveryLimit: 2,
    approvalRequirements: [],
  },
  parallel_implementation: {
    strategy: "parallel_implementation",
    allowedStates: ["task", "execute", "verify"],
    maximumSpecialists: 4,
    requiredCapabilities: ["planning", "ownership_leases"],
    requiredReviewers: 1,
    verificationLevel: "full",
    contextBudget: 48000,
    modelTier: "general_coding",
    recoveryLimit: 2,
    approvalRequirements: [],
  },
  root_cause_repair: {
    strategy: "root_cause_repair",
    allowedStates: ["execute", "verify"],
    maximumSpecialists: 2,
    requiredCapabilities: [],
    requiredReviewers: 1,
    verificationLevel: "full",
    contextBudget: 40000,
    modelTier: "strong_reasoning",
    recoveryLimit: 3,
    approvalRequirements: [],
  },
  audit_only: {
    strategy: "audit_only",
    allowedStates: ["review", "verify"],
    maximumSpecialists: 1,
    requiredCapabilities: ["read_only"],
    requiredReviewers: 1,
    verificationLevel: "full",
    contextBudget: 32000,
    modelTier: "strong_reasoning",
    recoveryLimit: 1,
    approvalRequirements: [],
  },
  repair_and_independent_audit: {
    strategy: "repair_and_independent_audit",
    allowedStates: ["execute", "review", "verify"],
    maximumSpecialists: 3,
    requiredCapabilities: ["code_mutation", "independent_review"],
    requiredReviewers: 2,
    verificationLevel: "release",
    contextBudget: 56000,
    modelTier: "strong_reasoning",
    recoveryLimit: 3,
    approvalRequirements: [],
  },
  recovery_resume: {
    strategy: "recovery_resume",
    allowedStates: ["task", "execute"],
    maximumSpecialists: 2,
    requiredCapabilities: [],
    requiredReviewers: 1,
    verificationLevel: "full",
    contextBudget: 24000,
    modelTier: "general_coding",
    recoveryLimit: 1,
    approvalRequirements: [],
  },
}

/**
 * Returns the policy for `strategy`.
 * A shallow copy is returned so callers cannot mutate the shared defaults.
 */
export function getStrategyPolicy(strategy: ExecutionStrategy): StrategyPolicy {
  return { ...DEFAULT_STRATEGY_POLICIES[strategy] }
}

/** Zod schema for a RunStage value. */
export const zRunStage = z.enum(["task", "review", "execute", "verify", "done"] as const)

/** Zod schema for an ExecutionStrategy value. */
export const zExecutionStrategy = z.enum(EXECUTION_STRATEGIES)

/** Zod schema for a VerificationLevel value. */
export const zVerificationLevel = z.enum(["focused", "standard", "full", "release"] as const)

/** Zod schema for a StrategyPolicy. */
export const zStrategyPolicy = z.object({
  strategy: zExecutionStrategy,
  allowedStates: z.array(zRunStage),
  maximumSpecialists: z.number().int().min(0),
  requiredCapabilities: z.array(z.string()),
  requiredReviewers: z.number().int().min(0),
  verificationLevel: zVerificationLevel,
  contextBudget: z.number().int().min(0),
  modelTier: zModelTier,
  recoveryLimit: z.number().int().min(0),
  approvalRequirements: z.array(z.string()),
})
