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

/** Every task class value, in a stable order. */
export const TASK_CLASSES = [
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
] as const satisfies readonly TaskClass[]

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

/** Returns true when `value` is one of the canonical execution strategies. */
export function isValidExecutionStrategy(value: unknown): value is ExecutionStrategy {
  return (EXECUTION_STRATEGIES as readonly unknown[]).includes(value)
}

/** Rejects empty and whitespace-only identifier strings. */
export const zNonEmptyId = z.string().refine((s) => s.trim().length > 0, {
  message: "must not be empty or whitespace-only",
})

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

/** Zod schema for an EvidenceReference; ids must be non-empty identifiers. */
export const zEvidenceReference = z.object({
  id: zNonEmptyId,
  source: z.string(),
  detail: z.string(),
})

/** Zod schema for ScoredTask. Every dimension must carry non-empty evidence. */
export const zScoredTask = z.object({
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

/** Zod schema for a RoutingInputEvidence entry. */
export const zRoutingInputEvidence = z.object({
  signal: z.string(),
  value: z.unknown(),
  source: z.string(),
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
export const zClassificationResult = z.object({
  taskClass: zTaskClass,
  confidence: z.number().min(0).max(100),
  evidence: z.array(zEvidenceReference),
  usedModelFallback: z.boolean(),
  policyVersion: zVersionId,
})
