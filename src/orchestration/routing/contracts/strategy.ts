/**
 * Routing contract: execution strategy policies.
 *
 * A strategy bundles the execution posture (how many specialists, which
 * pipeline stages, verification depth, model tier) for a routed task. The
 * canonical strategy vocabulary (ExecutionStrategy and its values) lives in
 * task.ts, which is the dependency-free taxonomy hub of the contracts
 * package, and is surfaced to consumers through the contracts barrel
 * (index.ts); this module consumes it without re-exporting it.
 */

import { z } from "zod"
import type { ModelTier } from "./models"
import { zModelTier, CAPABILITY_TIER_FLOOR, tierMeetsCapabilityFloor } from "./models"
import type { Capability } from "./agents"
import { type ExecutionStrategy, zExecutionStrategy, zNonEmptyId } from "./task"
import { deepFreeze } from "./immutability"

/**
 * Documented maximum for `recoveryLimit`. Any policy above this bound is
 * invalid — a recovery loop with an unbounded retry budget is a safety risk.
 */
export const MAX_RECOVERY_LIMIT = 3

/**
 * Documented maximum for `maximumSpecialists`. Strategies are bounded so a
 * parallel strategy cannot request an unbounded specialist fan-out.
 */
export const MAX_SPECIALISTS_LIMIT = 8

/** The five pipeline stages a strategy may be allowed to operate in. */
export type RunStage = "task" | "review" | "execute" | "verify" | "done"

/** Verification depth requested for a strategy. */
export type VerificationLevel = "focused" | "standard" | "full" | "release"

/**
 * Approval requirement attached to every high-risk-capable default strategy
 * (document section 5.5: high-risk tasks require at least one approval).
 * A strategy is high-risk compatible only when `approvalRequirements`
 * contains this exact canonical requirement; an arbitrary non-empty approval
 * string does not satisfy the posture.
 */
export const HIGH_RISK_APPROVAL_REQUIREMENT = "high_risk_approval"

/**
 * Capabilities a high-risk task must be able to satisfy. High-risk signals
 * (security, migration, release, package publication, destructive Git,
 * infrastructure change) all map to `strong_reasoning` in the
 * CAPABILITY_TIER_FLOOR projection, so a high-risk-compatible strategy's
 * model tier must satisfy this floor.
 */
export const HIGH_RISK_CAPABILITY_FLOOR: readonly Capability[] = deepFreeze([
  "security audit",
  "database migration",
  "release operation",
  "package publication",
  "destructive Git",
  "infrastructure change",
])

/**
 * Returns true when every capability in `capabilities` is recognized by the
 * canonical capability-tier floor projection (document section 7.2).
 */
export function capabilitiesAreRecognized(capabilities: readonly Capability[]): boolean {
  return capabilities.every((capability) => CAPABILITY_TIER_FLOOR[capability] !== undefined)
}

/** Runtime posture that governs how a routed task is executed. */
export interface StrategyPolicy {
  strategy: ExecutionStrategy
  allowedStates: RunStage[]
  maximumSpecialists: number
  requiredCapabilities: Capability[]
  requiredReviewers: number
  verificationLevel: VerificationLevel
  contextBudget: number
  modelTier: ModelTier
  recoveryLimit: number
  approvalRequirements: string[]
}

/**
 * Returns true when `policy` satisfies the section 5.5 high-risk posture:
 * full (or release) verification, at least one required reviewer, the review
 * stage present in `allowedStates`, the canonical high-risk approval
 * requirement present (not an arbitrary string), every required capability
 * recognized, and the model tier satisfying the high-risk capability floor.
 * Strategies that do not meet this posture (e.g. fast_direct: focused
 * verification, zero reviewers, no approvals) are incompatible with
 * high-risk tasks.
 */
export function isHighRiskCompatible(policy: StrategyPolicy): boolean {
  const hasFullVerification =
    policy.verificationLevel === "full" || policy.verificationLevel === "release"
  const hasReviewer = policy.requiredReviewers >= 1
  const hasCanonicalApproval = policy.approvalRequirements.includes(HIGH_RISK_APPROVAL_REQUIREMENT)
  const hasReviewStage = policy.allowedStates.includes("review")
  const recognizedCapabilities = capabilitiesAreRecognized(policy.requiredCapabilities)
  const tierMeetsFloor = tierMeetsCapabilityFloor(policy.modelTier, [...HIGH_RISK_CAPABILITY_FLOOR])

  return (
    hasFullVerification &&
    hasReviewer &&
    hasCanonicalApproval &&
    hasReviewStage &&
    recognizedCapabilities &&
    tierMeetsFloor
  )
}

/** Deterministic default policies, one per canonical execution strategy. */
export const DEFAULT_STRATEGY_POLICIES = deepFreeze({
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
    // "standard" verification requires the verify stage (contract invariant).
    allowedStates: ["task", "execute", "verify"],
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
    allowedStates: ["task", "execute", "review", "verify"],
    maximumSpecialists: 2,
    requiredCapabilities: ["planning"],
    requiredReviewers: 1,
    verificationLevel: "full",
    contextBudget: 32000,
    modelTier: "strong_reasoning",
    recoveryLimit: 2,
    approvalRequirements: [HIGH_RISK_APPROVAL_REQUIREMENT],
  },
  parallel_implementation: {
    strategy: "parallel_implementation",
    allowedStates: ["task", "execute", "review", "verify"],
    maximumSpecialists: 4,
    requiredCapabilities: ["planning", "ownership_leases"],
    requiredReviewers: 1,
    verificationLevel: "full",
    contextBudget: 48000,
    modelTier: "strong_reasoning",
    recoveryLimit: 2,
    approvalRequirements: [HIGH_RISK_APPROVAL_REQUIREMENT],
  },
  root_cause_repair: {
    strategy: "root_cause_repair",
    allowedStates: ["execute", "review", "verify"],
    maximumSpecialists: 2,
    requiredCapabilities: [],
    requiredReviewers: 1,
    verificationLevel: "full",
    contextBudget: 40000,
    modelTier: "strong_reasoning",
    recoveryLimit: 3,
    approvalRequirements: [HIGH_RISK_APPROVAL_REQUIREMENT],
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
    approvalRequirements: [HIGH_RISK_APPROVAL_REQUIREMENT],
  },
  repair_and_independent_audit: {
    strategy: "repair_and_independent_audit",
    allowedStates: ["execute", "review", "verify"],
    maximumSpecialists: 3,
    requiredCapabilities: ["code mutation", "independent_review"],
    requiredReviewers: 2,
    verificationLevel: "release",
    contextBudget: 56000,
    modelTier: "strong_reasoning",
    recoveryLimit: 3,
    approvalRequirements: [HIGH_RISK_APPROVAL_REQUIREMENT],
  },
  recovery_resume: {
    strategy: "recovery_resume",
    allowedStates: ["task", "execute", "review", "verify"],
    maximumSpecialists: 2,
    requiredCapabilities: [],
    requiredReviewers: 1,
    verificationLevel: "full",
    contextBudget: 24000,
    modelTier: "strong_reasoning",
    recoveryLimit: 1,
    approvalRequirements: [HIGH_RISK_APPROVAL_REQUIREMENT],
  },
} as const satisfies Record<ExecutionStrategy, StrategyPolicy>)

/**
 * Returns a deep clone of the policy for `strategy` so callers can safely
 * mutate their copy without affecting the frozen defaults.
 */
export function getStrategyPolicy(strategy: ExecutionStrategy): StrategyPolicy {
  return JSON.parse(JSON.stringify(DEFAULT_STRATEGY_POLICIES[strategy]))
}

/** Zod schema for a RunStage value. */
export const zRunStage = z.enum(["task", "review", "execute", "verify", "done"] as const)

/** Zod schema for a VerificationLevel value. */
export const zVerificationLevel = z.enum(["focused", "standard", "full", "release"] as const)

/**
 * Zod schema for a StrategyPolicy with cross-field invariants.
 *
 * Invariants:
 * - `allowedStates` is non-empty and contains unique stages.
 * - required capabilities are unique and recognised by the canonical floor.
 * - approval requirements are unique and meaningful.
 * - a strategy requiring reviewers must include the `review` stage.
 * - verification other than `focused` must include the `verify` stage.
 * - `contextBudget > 0` and `recoveryLimit` is bounded by MAX_RECOVERY_LIMIT.
 * - `maximumSpecialists` is bounded by MAX_SPECIALISTS_LIMIT.
 * - a policy carrying the canonical high-risk approval must pass the full
 *   high-risk posture (no contradictory low-risk configurations).
 */
export const zStrategyPolicy = z
  .object({
    strategy: zExecutionStrategy,
    allowedStates: z.array(zRunStage),
    maximumSpecialists: z.number().int().min(0),
    requiredCapabilities: z.array(zNonEmptyId),
    requiredReviewers: z.number().int().min(0),
    verificationLevel: zVerificationLevel,
    contextBudget: z.number().int().min(0),
    modelTier: zModelTier,
    recoveryLimit: z.number().int().min(0),
    approvalRequirements: z.array(z.string()),
  })
  .superRefine((p, ctx) => {
    // allowedStates must be non-empty and unique.
    if (p.allowedStates.length === 0) {
      ctx.addIssue({ code: "custom", path: ["allowedStates"], message: "allowedStates must be non-empty" })
    }
    {
      const seen = new Set<string>()
      for (const stage of p.allowedStates) {
        if (seen.has(stage)) {
          ctx.addIssue({ code: "custom", path: ["allowedStates"], message: `duplicate stage "${stage}"` })
          break
        }
        seen.add(stage)
      }
    }
    // Required capabilities unique and recognised.
    {
      const seen = new Set<string>()
      for (const capability of p.requiredCapabilities) {
        if (CAPABILITY_TIER_FLOOR[capability] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["requiredCapabilities"],
            message: `unknown capability "${capability}"`,
          })
        }
        if (seen.has(capability)) {
          ctx.addIssue({
            code: "custom",
            path: ["requiredCapabilities"],
            message: `duplicate capability "${capability}"`,
          })
          break
        }
        seen.add(capability)
      }
    }
    // Approval requirements unique and meaningful.
    {
      const seen = new Set<string>()
      for (const approval of p.approvalRequirements) {
        if (approval.trim().length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["approvalRequirements"],
            message: "approval requirements must be meaningful",
          })
        }
        if (seen.has(approval)) {
          ctx.addIssue({
            code: "custom",
            path: ["approvalRequirements"],
            message: `duplicate approval requirement "${approval}"`,
          })
          break
        }
        seen.add(approval)
      }
    }
    // A strategy requiring reviewers must include the review stage.
    if (p.requiredReviewers > 0 && !p.allowedStates.includes("review")) {
      ctx.addIssue({
        code: "custom",
        path: ["requiredReviewers"],
        message: "a strategy requiring reviewers must include the review stage",
      })
    }
    // Verification other than focused must include the verify stage.
    if (p.verificationLevel !== "focused" && !p.allowedStates.includes("verify")) {
      ctx.addIssue({
        code: "custom",
        path: ["verificationLevel"],
        message: `a strategy with verification level "${p.verificationLevel}" must include the verify stage`,
      })
    }
    // contextBudget > 0.
    if (p.contextBudget <= 0) {
      ctx.addIssue({ code: "custom", path: ["contextBudget"], message: "contextBudget must be > 0" })
    }
    // recoveryLimit bounded.
    if (p.recoveryLimit > MAX_RECOVERY_LIMIT) {
      ctx.addIssue({
        code: "custom",
        path: ["recoveryLimit"],
        message: `recoveryLimit must be <= ${MAX_RECOVERY_LIMIT}`,
      })
    }
    // maximumSpecialists bounded.
    if (p.maximumSpecialists > MAX_SPECIALISTS_LIMIT) {
      ctx.addIssue({
        code: "custom",
        path: ["maximumSpecialists"],
        message: `maximumSpecialists must be <= ${MAX_SPECIALISTS_LIMIT}`,
      })
    }
    // A strategy carrying the canonical high-risk approval must pass the
    // full high-risk posture — no contradictory low-risk configuration.
    if (p.approvalRequirements.includes(HIGH_RISK_APPROVAL_REQUIREMENT)) {
      if (!isHighRiskCompatible(p)) {
        ctx.addIssue({
          code: "custom",
          path: ["approvalRequirements"],
          message:
            "a strategy carrying the high-risk approval requirement must satisfy the full high-risk posture (full verification, >= 1 reviewer, review stage, strong-reasoning tier)",
        })
      }
    }
  })

// Load-time invariant: every default policy must validate. Run once at
// module load so a broken default fails immediately rather than at runtime.
// This check lives after both zStrategyPolicy and DEFAULT_STRATEGY_POLICIES
// are defined, so there is no circular initialization dependency.
for (const policy of Object.values(DEFAULT_STRATEGY_POLICIES)) {
  const parsed = zStrategyPolicy.safeParse(policy)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    throw new Error(`default strategy policy "${policy.strategy}" failed validation at load: ${details}`)
  }
}

/**
 * Fields callers may NOT override for a canonical strategy id. Canonical
 * strategy identifiers are FIXED: a policy named `fast_direct` must BE the
 * canonical fast_direct semantics. A caller needing different semantics must
 * use a custom policy id (never a canonical id).
 */
export const CANONICAL_STRATEGY_LOCKED_FIELDS = [
  "allowedStates",
  "maximumSpecialists",
  "requiredCapabilities",
  "requiredReviewers",
  "verificationLevel",
  "modelTier",
  "recoveryLimit",
  "approvalRequirements",
] as const

/**
 * Validates that a policy carrying a CANONICAL strategy id matches the
 * registered canonical policy semantics exactly.
 *
 * Returns an array of problem descriptions (empty when the policy is
 * semantically identical to the canonical default). A canonical strategy id
 * must never be reused with different semantics — a custom policy must use a
 * custom `policyId` instead (versioned custom policies are outside PR 1;
 * they must not masquerade as canonical strategies).
 *
 * The strategy's runtime budget may be tuned via a separately managed
 * budget table (section 8.5) — `contextBudget` is not part of the canonical
 * semantics locked here.
 */
export function validateCanonicalStrategyPolicy(
  policy: StrategyPolicy,
): string[] {
  const canonical = DEFAULT_STRATEGY_POLICIES[policy.strategy]
  if (canonical === undefined) {
    return [`no canonical policy registered for strategy "${policy.strategy}"`]
  }
  const problems: string[] = []
  for (const field of CANONICAL_STRATEGY_LOCKED_FIELDS) {
    const key = field as keyof StrategyPolicy
    const actual = policy[key]
    const expected = canonical[key]
    const actualJson = JSON.stringify(actual)
    const expectedJson = JSON.stringify(expected)
    if (actualJson !== expectedJson) {
      problems.push(
        `strategy "${policy.strategy}" field "${field}" (${actualJson}) must equal the canonical default (${expectedJson})`,
      )
    }
  }
  return problems
}
