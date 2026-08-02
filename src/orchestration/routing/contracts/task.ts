/**
 * Routing contract: routing taxonomy and task classification.
 *
 * This module defines the shared vocabularies of the routing layer: the task
 * taxonomy (TaskClass), the canonical execution-strategy vocabulary, the
 * evidence types, and the score types. It is the dependency-free hub of the
 * contracts package — both strategy.ts and models.ts import from here, so
 * shared vocabulary that both need at runtime (ExecutionStrategy, score and
 * evidence types) lives in this module rather than in either consumer.
 */

import { z } from "zod"
import { isCanonicalSerializable } from "./canonical"
import { deepFreeze } from "./immutability"

/** Lower bound of every score produced by the classifier and the scorers. */
export const SCORE_MIN = 0

/** Upper bound of every score produced by the classifier and the scorers. */
export const SCORE_MAX = 100

/**
 * The full taxonomy of task classes understood by the routing layer.
 * "unknown" is the fallback class when classification cannot decide.
 */
export type TaskClass =
  | "trivial_edit"
  | "documentation"
  | "read_only_question"
  | "repository_audit"
  | "local_bug"
  | "cross_module_feature"
  | "ci_failure"
  | "build_package_failure"
  | "release_failure"
  | "database_migration"
  | "concurrency_failure"
  | "security_review"
  | "performance_work"
  | "ui_feature"
  | "production_incident"
  | "recovery_resume"
  | "unknown"

/** Every task class value, in a stable order. Deeply frozen at module load. */
export const TASK_CLASSES = deepFreeze([
  "trivial_edit",
  "documentation",
  "read_only_question",
  "repository_audit",
  "local_bug",
  "cross_module_feature",
  "ci_failure",
  "build_package_failure",
  "release_failure",
  "database_migration",
  "concurrency_failure",
  "security_review",
  "performance_work",
  "ui_feature",
  "production_incident",
  "recovery_resume",
  "unknown",
] as const satisfies readonly TaskClass[])

/** Returns true when `value` is one of the canonical task classes. */
export function isValidTaskClass(value: unknown): value is TaskClass {
  return (TASK_CLASSES as readonly unknown[]).includes(value)
}

/** Returns true when `n` lies within the shared 0-100 score range. */
export function isScoreInRange(n: number): boolean {
  return Number.isFinite(n) && n >= SCORE_MIN && n <= SCORE_MAX
}

/** Returns true when every element in `scores` lies within the shared 0-100 score range. */
export function areScoresInRange(scores: readonly number[]): boolean {
  return scores.every(isScoreInRange)
}

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

/** Every canonical execution strategy, in a stable order. Deeply frozen. */
export const EXECUTION_STRATEGIES = deepFreeze([
  "fast_direct",
  "direct_verified",
  "explore_then_execute",
  "planned_execution",
  "parallel_implementation",
  "root_cause_repair",
  "audit_only",
  "repair_and_independent_audit",
  "recovery_resume",
] as const satisfies readonly ExecutionStrategy[])

/** Returns true when `value` is one of the canonical execution strategies. */
export function isValidExecutionStrategy(value: unknown): value is ExecutionStrategy {
  return (EXECUTION_STRATEGIES as readonly unknown[]).includes(value)
}

/**
 * Rejects empty and whitespace-only identifier strings and trims the stored
 * value so comparisons are always made against canonical (trimmed) ids.
 */
export const zNonEmptyId = z
  .string()
  .trim()
  .refine((s) => s.length > 0, {
    message: "must not be empty or whitespace-only",
  })

/**
 * Meaningful free-text: trimmed, non-empty, and not a bare placeholder token
 * ("unknown", "n/a", "none", "tbd", "-", …) unless followed by an explanatory
 * detail. Used for evidence source/detail, signals, and summaries so a
 * record can never carry empty, whitespace-only, or placeholder evidence.
 */
export const PLACEHOLDER_TOKENS: readonly string[] = deepFreeze([
  "unknown",
  "n/a",
  "na",
  "none",
  "tbd",
  "todo",
  "tba",
  "-",
  "null",
  "undefined",
  "later",
  "unavailable",
])

export function isMeaningfulText(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  return !PLACEHOLDER_TOKENS.includes(trimmed.toLowerCase())
}

/** Zod schema: trimmed, non-empty, non-placeholder free text. */
export const zMeaningfulString = z
  .string()
  .trim()
  .refine(isMeaningfulText, { message: "must be meaningful (non-empty, non-whitespace, not a bare placeholder)" })

/**
 * Validated version identifier: a non-empty string of the form
 * MAJOR.MINOR.PATCH with optional prerelease and build metadata, e.g.
 * "1.0.0" or "1.0.0-rc.1". Rejects empty, whitespace-only, and malformed
 * version strings so a bound record can never carry an unparseable version.
 */
export const zVersionId = z.string().regex(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  "must be a valid MAJOR.MINOR.PATCH version identifier",
)

/** Scorer output: four 0-100 dimensions consumed by strategy and model selection. */
export interface TaskScores {
  complexity: number
  ambiguity: number
  risk: number
  confidence: number
}

/** A traceable justification for a classification decision. */
export interface EvidenceReference {
  id: string
  /** Stable code path or rule id that produced this evidence. */
  source: string
  /** Human-readable description of the evidence. */
  detail: string
}

/**
 * A raw routing input recorded at decision time. Unlike score evidence
 * (EvidenceReference, which carries stable ids), an input evidence entry
 * records the observed value of a signal dimension: `signal` names the input
 * dimension, `value` is the observed value, `source` is a stable reference
 * (file path, tool output pointer, prompt fragment index).
 */
export interface RoutingInputEvidence {
  signal: string
  value: unknown
  source: string
}

/**
 * Optional-friendly inputs consumed by the classifier and the scorers.
 * Every field is optional so partial observations still classify.
 */
export interface ClassificationInput {
  readOnly?: boolean
  mutating?: boolean
  expectedFileCount?: number
  expectedDomainCount?: number
  hasTests?: boolean
  repositoryCriticality?: number
  productionImpact?: number
  releaseImpact?: boolean
  dataIntegrityInvolved?: boolean
  securitySensitive?: boolean
  destructiveOperations?: boolean
  migrationInvolved?: boolean
  concurrencyInvolved?: boolean
  authInvolved?: boolean
  packagePublication?: boolean
  infrastructureChange?: boolean
  rollbackDifficulty?: boolean
  uncertainExternalSideEffects?: boolean
  uiInvolved?: boolean
  ciContext?: boolean
  buildOrPackageFailure?: boolean
  explicitAuditRequest?: boolean
  ambiguityLevel?: number
  needsIndependentReview?: boolean
  userRequiredSpecialist?: string
  recoveryState?: boolean
  rawPrompt?: string
}

/** Output of the classifier: a class plus evidence and policy provenance. */
export interface ClassificationResult {
  taskClass: TaskClass
  confidence: number
  evidence: EvidenceReference[]
  usedModelFallback: boolean
  policyVersion: string
}

/** Zod schema for a TaskClass value. */
export const zTaskClass = z.enum(TASK_CLASSES)

/** Zod schema for an ExecutionStrategy value. */
export const zExecutionStrategy = z.enum(EXECUTION_STRATEGIES)

/** Zod schema for TaskScores; every score is an integer within 0-100. */
export const zTaskScores = z.object({
  complexity: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
  ambiguity: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
  risk: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
  confidence: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
})

/** Zod schema for an array of TaskScores. */
export const zTaskScoresArray = z.array(zTaskScores)

/**
 * Complete scoring-domain object carrying scores, per-dimension evidence,
 * and the policy/weights versions that produced them.
 */
export interface ScoredTask {
  scores: TaskScores
  evidence: {
    complexity: EvidenceReference[]
    ambiguity: EvidenceReference[]
    risk: EvidenceReference[]
    confidence: EvidenceReference[]
  }
  weightsVersion: string
  policyVersion: string
}

/** Zod schema for an EvidenceReference; ids and text must be meaningful. */
export const zEvidenceReference = z.object({
  id: zNonEmptyId,
  source: zMeaningfulString,
  detail: zMeaningfulString,
})

/** Zod schema for ScoredTask. Every dimension must carry non-empty evidence. */
export const zScoredTask = z
  .object({
    scores: zTaskScores,
    evidence: z.object({
      complexity: z.array(zEvidenceReference).min(1, "complexity evidence must be non-empty"),
      ambiguity: z.array(zEvidenceReference).min(1, "ambiguity evidence must be non-empty"),
      risk: z.array(zEvidenceReference).min(1, "risk evidence must be non-empty"),
      confidence: z.array(zEvidenceReference).min(1, "confidence evidence must be non-empty"),
    }),
    weightsVersion: zVersionId,
    policyVersion: zVersionId,
  })
  .superRefine((s, ctx) => {
    const dimensions: Array<[string, EvidenceReference[]]> = [
      ["complexity", s.evidence.complexity],
      ["ambiguity", s.evidence.ambiguity],
      ["risk", s.evidence.risk],
      ["confidence", s.evidence.confidence],
    ]
    // Unique within each dimension.
    for (const [dimension, entries] of dimensions) {
      const seen = new Set<string>()
      for (const entry of entries) {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["evidence", dimension],
            message: `score evidence ids must be unique within the ${dimension} dimension`,
          })
          break
        }
        seen.add(entry.id)
      }
    }
    // No cross-dimension duplicate evidence ids.
    const allIds = new Map<string, string>()
    for (const [dimension, entries] of dimensions) {
      for (const entry of entries) {
        const existing = allIds.get(entry.id)
        if (existing !== undefined && existing !== dimension) {
          ctx.addIssue({
            code: "custom",
            path: ["evidence"],
            message: `cross-dimension duplicate evidence id "${entry.id}" (${existing} vs ${dimension}) is not permitted`,
          })
        } else if (existing === undefined) {
          allIds.set(entry.id, dimension)
        }
      }
    }
  })

/** Zod schema for a RoutingInputEvidence entry. */
export const zRoutingInputEvidence = z.object({
  signal: zMeaningfulString,
  // The observed value is required provenance: `undefined` must not silently
  // disappear during canonical serialization. Valid falsy values (0, false,
  // "", null) remain acceptable real observed values — see the null policy
  // documented in §5.4 of the architecture doc.
  value: z
    .unknown()
    .refine((value) => value !== undefined, {
      message: "routing evidence value must be explicitly present (undefined is not a valid observed value)",
    })
    .refine(isCanonicalSerializable, {
      message: "evidence value must be canonically serializable (no unsupported objects)",
    }),
  source: zMeaningfulString,
})

/** Zod schema for ClassificationInput; every field is optional. */
export const zClassificationInput = z.object({
  readOnly: z.boolean().optional(),
  mutating: z.boolean().optional(),
  expectedFileCount: z.number().int().min(0).optional(),
  expectedDomainCount: z.number().int().min(0).optional(),
  hasTests: z.boolean().optional(),
  repositoryCriticality: z.number().int().min(SCORE_MIN).max(SCORE_MAX).optional(),
  productionImpact: z.number().int().min(SCORE_MIN).max(SCORE_MAX).optional(),
  releaseImpact: z.boolean().optional(),
  dataIntegrityInvolved: z.boolean().optional(),
  securitySensitive: z.boolean().optional(),
  destructiveOperations: z.boolean().optional(),
  migrationInvolved: z.boolean().optional(),
  concurrencyInvolved: z.boolean().optional(),
  authInvolved: z.boolean().optional(),
  packagePublication: z.boolean().optional(),
  infrastructureChange: z.boolean().optional(),
  rollbackDifficulty: z.boolean().optional(),
  uncertainExternalSideEffects: z.boolean().optional(),
  uiInvolved: z.boolean().optional(),
  ciContext: z.boolean().optional(),
  buildOrPackageFailure: z.boolean().optional(),
  explicitAuditRequest: z.boolean().optional(),
  ambiguityLevel: z.number().int().min(SCORE_MIN).max(SCORE_MAX).optional(),
  needsIndependentReview: z.boolean().optional(),
  userRequiredSpecialist: z.string().optional(),
  recoveryState: z.boolean().optional(),
  rawPrompt: z.string().optional(),
})

/** Zod schema for a ClassificationResult. */
export const zClassificationResult = z
  .object({
    taskClass: zTaskClass,
    confidence: z.number().min(0).max(100),
    evidence: z.array(zEvidenceReference),
    usedModelFallback: z.boolean(),
    policyVersion: zVersionId,
  })
  .superRefine((r, ctx) => {
    if (r.evidence.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "classification evidence must contain at least one entry",
      })
    }
    const seen = new Set<string>()
    for (const entry of r.evidence) {
      if (seen.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence"],
          message: "classification evidence ids must be unique",
        })
        break
      }
      seen.add(entry.id)
    }
  })
