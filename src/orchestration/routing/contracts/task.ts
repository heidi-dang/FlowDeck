/**
 * Routing contract: task classification.
 *
 * This module defines the taxonomy used to classify incoming tasks before
 * routing. Every task is assigned exactly one TaskClass; scorers produce
 * 0-100 scores that feed execution-strategy and model-tier selection.
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
  securitySensitive?: boolean
  migrationInvolved?: boolean
  concurrencyInvolved?: boolean
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

/** Zod schema for TaskScores; every score is an integer within 0-100. */
export const zTaskScores = z.object({
  complexity: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
  ambiguity: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
  risk: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
  confidence: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
})

/** Zod schema for an EvidenceReference. */
export const zEvidenceReference = z.object({
  id: z.string(),
  source: z.string(),
  detail: z.string(),
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
  securitySensitive: z.boolean().optional(),
  migrationInvolved: z.boolean().optional(),
  concurrencyInvolved: z.boolean().optional(),
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
  policyVersion: z.string(),
})
