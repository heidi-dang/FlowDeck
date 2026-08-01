/**
 * Deterministic complexity, ambiguity, and risk scorers for the routing layer.
 *
 * Every scorer is pure and deterministic: given the same ClassificationInput
 * (and optional weights) it always returns the same score and evidence. No
 * randomness, clock reads, or model calls occur anywhere in this module.
 *
 * Scores are clamped to SCORE_MIN..SCORE_MAX and rounded to integers so the
 * output of computeTaskScores always satisfies the zTaskScores schema.
 *
 * Weights configure the relative contribution of each signal. Changing any
 * value in DEFAULT_WEIGHTS changes the meaning of every score the routing
 * layer produces, so such a change MUST bump WEIGHTS_VERSION. Signals whose
 * weight is not yet consumed by the current formula are reserved for future
 * formula revisions and still participate in the versioning contract.
 */

import {
  SCORE_MAX,
  SCORE_MIN,
  isScoreInRange,
  zTaskScores,
  type ClassificationInput,
  type EvidenceReference,
  type TaskScores,
  type ScoredTask,
  ROUTING_WEIGHTS_VERSION,
  ROUTING_POLICY_VERSION,
} from "@/orchestration/routing/contracts"

/** Relative weight of every deterministic scoring signal. */
export interface ScoreWeights {
  complexity: {
    /** Multiplier per expected file, capped at 5 files. */
    perFile: number
    /** Multiplier per expected domain, capped at 3 domains. */
    perDomain: number
    /** Reserved: dependency depth scaling for future formula revisions. */
    perDependencyDepth: number
    /** Reserved: per-check scaling for future formula revisions. */
    perCheck: number
    /** Reserved: per-workstream scaling for future formula revisions. */
    perWorkstream: number
    /** Weight added when a migration is involved. */
    migrationWeight: number
    /** Weight added when concurrency is involved. */
    concurrencyWeight: number
    /** Reserved: cross-platform scaling for future formula revisions. */
    crossPlatformWeight: number
    /** Reserved: external-integration scaling for future formula revisions. */
    externalIntegrationWeight: number
  }
  ambiguity: {
    /** Reserved: missing-target signal scaling. */
    missingTarget: number
    /** Reserved: unclear-success signal scaling. */
    unclearSuccess: number
    /** Reserved: conflicting-requirements signal scaling. */
    conflictingRequirements: number
    /** Reserved: unknown-repository signal scaling. */
    unknownRepository: number
    /** Reserved: incomplete-reproduction signal scaling. */
    incompleteReproduction: number
    /** Reserved: missing-error-evidence signal scaling. */
    missingErrorEvidence: number
    /** Reserved: undefined-ownership signal scaling. */
    undefinedOwnership: number
  }
  risk: {
    /** Scaling denominator anchor for the production impact term (default 30). */
    productionWeight: number
    /** Weight added when the change touches a release. */
    releaseWeight: number
    /** Weight added when data integrity is involved. */
    dataIntegrityWeight: number
    /** Weight added when the change is security-sensitive. */
    securityWeight: number
    /** Weight added when the change is destructive. */
    destructiveWeight: number
    /** Weight added when a migration is involved. */
    migrationWeight: number
    /** Weight added when concurrency is involved. */
    concurrencyWeight: number
    /** Weight added when authentication/authorization is touched. */
    authWeight: number
    /** Weight added when a package is published or a registry mutated. */
    packagePublicationWeight: number
    /** Weight added when infrastructure changes. */
    infrastructureWeight: number
    /** Weight added when rollback is difficult. */
    rollbackDifficultyWeight: number
    /** Weight added when external side effects are uncertain. */
    externalSideEffectsWeight: number
  }
}

/**
 * Version of the weight configuration. Bump whenever any default weight
 * changes so persisted scores can be re-interpreted correctly.
 */
export const WEIGHTS_VERSION = "1.0.0"

/** Default deterministic weights for every scoring signal. */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  complexity: {
    perFile: 15,
    perDomain: 20,
    perDependencyDepth: 10,
    perCheck: 8,
    perWorkstream: 25,
    migrationWeight: 25,
    concurrencyWeight: 20,
    crossPlatformWeight: 15,
    externalIntegrationWeight: 20,
  },
  ambiguity: {
    missingTarget: 15,
    unclearSuccess: 15,
    conflictingRequirements: 20,
    unknownRepository: 15,
    incompleteReproduction: 20,
    missingErrorEvidence: 15,
    undefinedOwnership: 15,
  },
  risk: {
    productionWeight: 30,
    releaseWeight: 20,
    dataIntegrityWeight: 30,
    securityWeight: 35,
    destructiveWeight: 30,
    migrationWeight: 25,
    concurrencyWeight: 20,
    authWeight: 25,
    packagePublicationWeight: 25,
    infrastructureWeight: 25,
    rollbackDifficultyWeight: 15,
    externalSideEffectsWeight: 20,
  },
}

/** A dimension score plus the evidence that produced it. */
export interface ScoredDimension {
  score: number
  evidence: EvidenceReference[]
}

/** Universal floor for tasks carrying any high-risk signal. */
export const HIGH_RISK_FLOOR = 70

/** Fixed ambiguity contribution when the raw prompt is absent. */
const WEAK_SIGNAL_NO_TARGET = 15
/** Fixed ambiguity contribution when no target file count is known. */
const WEAK_SIGNAL_NO_PROMPT = 15
/** Fixed ambiguity contribution when neither file nor domain scope is known. */
const WEAK_SIGNAL_NO_OWNERSHIP = 10
/** Fixed ambiguity contribution when a mutating task lacks test evidence. */
const WEAK_SIGNAL_NO_VERIFICATION = 10

/** Complexity contribution of the verification surface (hasTests). */
const COMPLEXITY_HAS_TESTS = 10
/** Complexity contribution of UI involvement. */
const COMPLEXITY_UI_INVOLVED = 15
/** Complexity contribution of a CI context. */
const COMPLEXITY_CI_CONTEXT = 10
/** Complexity contribution of a cross-module or integration prompt. */
const COMPLEXITY_CROSS_MODULE = 10

/** Risk contribution of an independent-review requirement. */
const RISK_INDEPENDENT_REVIEW = 20
/** Risk contribution of destructive raw-prompt signals. */
const RISK_DESTRUCTIVE = 20
/** Risk contribution of auth-touching raw-prompt signals. */
const RISK_AUTH = 15
/** Risk contribution of a broad expected blast radius (>= 3 files). */
const RISK_BLAST_RADIUS = 15

/** Matches prompts describing cross-module or integration work. */
const CROSS_MODULE_PATTERN = /cross[- ]module|multi[- ](file|module|domain|service)|integration|distributed/i
/** Matches prompts describing destructive changes. */
const DESTRUCTIVE_PATTERN = /destruct|delete|drop|remove|force|wipe|reset|migrat/i
/** Matches prompts touching credentials or auth material. */
const SENSITIVE_PATTERN = /auth|credential|token|secret|password/i

/**
 * Clamps `n` to SCORE_MIN..SCORE_MAX and rounds it to an integer so every
 * produced score satisfies the zTaskScores schema.
 */
function clampScore(n: number): number {
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, Math.round(n)))
}

/**
 * Throws Error("score out of range") unless `score` is finite and within
 * SCORE_MIN..SCORE_MAX.
 */
export function assertScoreRange(score: number): void {
  if (!isScoreInRange(score)) {
    throw new Error("score out of range")
  }
}

/**
 * Scores the complexity of a task. Starts at 0 and accumulates one
 * deterministic term per signal, each with its own evidence entry.
 */
export function scoreComplexity(input: ClassificationInput, weights: ScoreWeights = DEFAULT_WEIGHTS): ScoredDimension {
  const evidence: EvidenceReference[] = []
  let score = 0

  const fileCount = Math.min(input.expectedFileCount ?? 0, 5)
  if (fileCount > 0) {
    score += weights.complexity.perFile * fileCount
    evidence.push({
      id: "score.cx.file_count",
      source: "scoring.complexity",
      detail: `expected file count adds ${weights.complexity.perFile} x ${fileCount}`,
    })
  }

  const domainCount = Math.min(input.expectedDomainCount ?? 0, 3)
  if (domainCount > 0) {
    score += weights.complexity.perDomain * domainCount
    evidence.push({
      id: "score.cx.domain_count",
      source: "scoring.complexity",
      detail: `expected domain count adds ${weights.complexity.perDomain} x ${domainCount}`,
    })
  }

  if (input.hasTests === true) {
    score += COMPLEXITY_HAS_TESTS
    evidence.push({
      id: "score.cx.has_tests",
      source: "scoring.complexity",
      detail: `verification surface adds ${COMPLEXITY_HAS_TESTS}`,
    })
  }

  if (input.migrationInvolved === true) {
    score += weights.complexity.migrationWeight
    evidence.push({
      id: "score.cx.migration",
      source: "scoring.complexity",
      detail: `migration involvement adds ${weights.complexity.migrationWeight}`,
    })
  }

  if (input.concurrencyInvolved === true) {
    score += weights.complexity.concurrencyWeight
    evidence.push({
      id: "score.cx.concurrency",
      source: "scoring.complexity",
      detail: `concurrency involvement adds ${weights.complexity.concurrencyWeight}`,
    })
  }

  if (input.uiInvolved === true) {
    score += COMPLEXITY_UI_INVOLVED
    evidence.push({
      id: "score.cx.ui",
      source: "scoring.complexity",
      detail: `UI involvement adds ${COMPLEXITY_UI_INVOLVED}`,
    })
  }

  if (input.ciContext === true) {
    score += COMPLEXITY_CI_CONTEXT
    evidence.push({
      id: "score.cx.ci_context",
      source: "scoring.complexity",
      detail: `CI context adds ${COMPLEXITY_CI_CONTEXT}`,
    })
  }

  if (input.rawPrompt !== undefined && CROSS_MODULE_PATTERN.test(input.rawPrompt)) {
    score += COMPLEXITY_CROSS_MODULE
    evidence.push({
      id: "score.cx.cross_module",
      source: "scoring.complexity",
      detail: `cross-module prompt adds ${COMPLEXITY_CROSS_MODULE}`,
    })
  }

  // A measured zero must still carry evidence: an empty complexity evidence
  // array is a defect (document section 5.4).
  if (evidence.length === 0) {
    evidence.push({
      id: "score.cx.no_contributing_signal",
      source: "scoring.complexity",
      detail: "no complexity signal contributed; measured zero",
    })
  }

  return { score: clampScore(score), evidence }
}

/**
 * Scores task ambiguity. An explicit ambiguityLevel is the primary signal
 * mapped 0..100 at 0.6 weight; weak signals contribute at half weight when a
 * positive level is present, at full weight when it is absent, and are
 * suppressed entirely when the level is explicitly 0 (a measured value of 0
 * supersedes the heuristics).
 */
export function scoreAmbiguity(input: ClassificationInput, weights: ScoreWeights = DEFAULT_WEIGHTS): ScoredDimension {
  void weights
  const evidence: EvidenceReference[] = []
  const hasExplicitLevel = input.ambiguityLevel !== undefined
  const level = input.ambiguityLevel ?? 0

  let score = 0.6 * level
  if (hasExplicitLevel && level > 0) {
    evidence.push({
      id: "score.amb.primary_level",
      source: "scoring.ambiguity",
      detail: `explicit ambiguity level contributes ${(0.6 * level).toFixed(1)}`,
    })
  }

  const weakFactor = !hasExplicitLevel ? 1 : level === 0 ? 0 : 0.5
  if (weakFactor === 0) {
    return {
      score: clampScore(score),
      evidence: [
        ...evidence,
        {
          id: "score.amb.explicit_zero",
          source: "scoring.ambiguity",
          detail: "ambiguity explicitly measured zero (level 0 supersedes weak signals)",
        },
      ],
    }
  }

  const missingTarget = input.expectedFileCount === undefined
  if (missingTarget) {
    score += weakFactor * WEAK_SIGNAL_NO_TARGET
    evidence.push({
      id: "score.amb.missing_target",
      source: "scoring.ambiguity",
      detail: `no expected file count adds ${weakFactor * WEAK_SIGNAL_NO_TARGET}`,
    })
  }

  const noPrompt = input.rawPrompt === undefined || input.rawPrompt.trim() === ""
  if (noPrompt) {
    score += weakFactor * WEAK_SIGNAL_NO_PROMPT
    evidence.push({
      id: "score.amb.unclear_incomplete",
      source: "scoring.ambiguity",
      detail: `no raw prompt adds ${weakFactor * WEAK_SIGNAL_NO_PROMPT}`,
    })
  }

  const undefinedOwnership = input.expectedFileCount === undefined && input.expectedDomainCount === undefined
  if (undefinedOwnership) {
    score += weakFactor * WEAK_SIGNAL_NO_OWNERSHIP
    evidence.push({
      id: "score.amb.undefined_ownership",
      source: "scoring.ambiguity",
      detail: `undefined scope adds ${weakFactor * WEAK_SIGNAL_NO_OWNERSHIP}`,
    })
  }

  const missingVerification = input.mutating === true && input.hasTests !== true
  if (missingVerification) {
    score += weakFactor * WEAK_SIGNAL_NO_VERIFICATION
    evidence.push({
      id: "score.amb.missing_verification",
      source: "scoring.ambiguity",
      detail: `mutating task without tests adds ${weakFactor * WEAK_SIGNAL_NO_VERIFICATION}`,
    })
  }

  // A measured zero must still carry evidence (document section 5.4).
  if (evidence.length === 0) {
    evidence.push({
      id: "score.amb.no_contributing_signal",
      source: "scoring.ambiguity",
      detail: "no ambiguity signal contributed; measured zero",
    })
  }

  return { score: clampScore(score), evidence }
}

/**
 * Scores task risk. The production impact term is scaled by
 * productionWeight/30 so the default weight maps 0..100 directly; every
 * contributing signal adds its own evidence entry.
 */
export function scoreRisk(input: ClassificationInput, weights: ScoreWeights = DEFAULT_WEIGHTS): ScoredDimension {
  const evidence: EvidenceReference[] = []
  let score = 0

  const productionImpact = input.productionImpact ?? 0
  const productionTerm = productionImpact * (weights.risk.productionWeight / 30)
  if (productionTerm > 0) {
    score += productionTerm
    evidence.push({
      id: "score.risk.production",
      source: "scoring.risk",
      detail: `production impact ${productionImpact} contributes ${productionTerm}`,
    })
  }

  if (input.releaseImpact === true) {
    score += weights.risk.releaseWeight
    evidence.push({
      id: "score.risk.release",
      source: "scoring.risk",
      detail: `release impact adds ${weights.risk.releaseWeight}`,
    })
  }

  if (input.dataIntegrityInvolved === true) {
    score += weights.risk.dataIntegrityWeight
    evidence.push({
      id: "score.risk.data_integrity",
      source: "scoring.risk",
      detail: `data integrity involvement adds ${weights.risk.dataIntegrityWeight}`,
    })
  }

  if (input.securitySensitive === true) {
    score += weights.risk.securityWeight
    evidence.push({
      id: "score.risk.security",
      source: "scoring.risk",
      detail: `security sensitivity adds ${weights.risk.securityWeight}`,
    })
  }

  if (input.destructiveOperations === true) {
    score += weights.risk.destructiveWeight
    evidence.push({
      id: "score.risk.destructive",
      source: "scoring.risk",
      detail: `destructive operations add ${weights.risk.destructiveWeight}`,
    })
  }

  if (input.migrationInvolved === true) {
    score += weights.risk.migrationWeight
    evidence.push({
      id: "score.risk.migration",
      source: "scoring.risk",
      detail: `migration involvement adds ${weights.risk.migrationWeight}`,
    })
  }

  if (input.concurrencyInvolved === true) {
    score += weights.risk.concurrencyWeight
    evidence.push({
      id: "score.risk.concurrency",
      source: "scoring.risk",
      detail: `concurrency involvement adds ${weights.risk.concurrencyWeight}`,
    })
  }

  if (input.authInvolved === true) {
    score += weights.risk.authWeight
    evidence.push({
      id: "score.risk.auth",
      source: "scoring.risk",
      detail: `authentication/authorization involvement adds ${weights.risk.authWeight}`,
    })
  }

  if (input.packagePublication === true) {
    score += weights.risk.packagePublicationWeight
    evidence.push({
      id: "score.risk.package_publication",
      source: "scoring.risk",
      detail: `package publication adds ${weights.risk.packagePublicationWeight}`,
    })
  }

  if (input.infrastructureChange === true) {
    score += weights.risk.infrastructureWeight
    evidence.push({
      id: "score.risk.infrastructure",
      source: "scoring.risk",
      detail: `infrastructure change adds ${weights.risk.infrastructureWeight}`,
    })
  }

  if (input.rollbackDifficulty === true) {
    score += weights.risk.rollbackDifficultyWeight
    evidence.push({
      id: "score.risk.rollback_difficulty",
      source: "scoring.risk",
      detail: `rollback difficulty adds ${weights.risk.rollbackDifficultyWeight}`,
    })
  }

  if (input.uncertainExternalSideEffects === true) {
    score += weights.risk.externalSideEffectsWeight
    evidence.push({
      id: "score.risk.external_side_effects",
      source: "scoring.risk",
      detail: `uncertain external side effects add ${weights.risk.externalSideEffectsWeight}`,
    })
  }

  if (input.needsIndependentReview === true) {
    score += RISK_INDEPENDENT_REVIEW
    evidence.push({
      id: "score.risk.independent_review",
      source: "scoring.risk",
      detail: `independent review adds ${RISK_INDEPENDENT_REVIEW}`,
    })
  }

  if (input.destructiveOperations !== true && input.rawPrompt !== undefined && DESTRUCTIVE_PATTERN.test(input.rawPrompt)) {
    score += RISK_DESTRUCTIVE
    evidence.push({
      id: "score.risk.destructive_prompt",
      source: "scoring.risk",
      detail: `destructive prompt adds ${RISK_DESTRUCTIVE}`,
    })
  }

  if (input.authInvolved !== true && input.rawPrompt !== undefined && SENSITIVE_PATTERN.test(input.rawPrompt)) {
    score += RISK_AUTH
    evidence.push({
      id: "score.risk.auth_prompt",
      source: "scoring.risk",
      detail: `auth-touching prompt adds ${RISK_AUTH}`,
    })
  }

  if ((input.expectedFileCount ?? 0) >= 3) {
    score += RISK_BLAST_RADIUS
    evidence.push({
      id: "score.risk.blast_radius",
      source: "scoring.risk",
      detail: `expected file count >= 3 adds ${RISK_BLAST_RADIUS}`,
    })
  }

  // A measured zero must still carry evidence (document section 5.4).
  if (evidence.length === 0) {
    evidence.push({
      id: "score.risk.no_contributing_signal",
      source: "scoring.risk",
      detail: "no risk signal contributed; measured zero",
    })
  }

  return { score: clampScore(score), evidence }
}

/**
 * Applies the universal high-risk floor. Any task carrying at least one of
 * the twelve canonical high-risk signals (productionImpact >= 70,
 * releaseImpact, dataIntegrityInvolved, securitySensitive,
 * destructiveOperations, migrationInvolved, concurrencyInvolved,
 * authInvolved, packagePublication, infrastructureChange, rollbackDifficulty,
 * uncertainExternalSideEffects) floors risk to HIGH_RISK_FLOOR (70). The
 * floor also applies for needsIndependentReview, a destructive/auth raw
 * prompt, or a blast radius of >= 3 files. The floor only applies when it
 * raises the risk score. A "score.risk.high_risk_minimum" evidence entry with
 * reason code HIGH_RISK_FLOOR is added when the floor takes effect.
 */
export function ensureHighRiskMinimum(
  input: ClassificationInput,
  risk: number,
  evidence: EvidenceReference[],
): { risk: number; evidence: EvidenceReference[] } {
  let updatedRisk = risk
  const updatedEvidence = [...evidence]

  const hasProductionImpact = input.productionImpact !== undefined && input.productionImpact >= 70
  const hasReleaseImpact = input.releaseImpact === true
  const hasDataIntegrity = input.dataIntegrityInvolved === true
  const hasSecuritySensitive = input.securitySensitive === true
  const hasDestructive = input.destructiveOperations === true
  const hasMigrationInvolved = input.migrationInvolved === true
  const hasConcurrencyInvolved = input.concurrencyInvolved === true
  const hasAuth = input.authInvolved === true
  const hasPackagePublication = input.packagePublication === true
  const hasInfrastructureChange = input.infrastructureChange === true
  const hasRollbackDifficulty = input.rollbackDifficulty === true
  const hasExternalSideEffects = input.uncertainExternalSideEffects === true
  const hasIndependentReview = input.needsIndependentReview === true
  const hasDestructivePrompt = input.rawPrompt !== undefined && DESTRUCTIVE_PATTERN.test(input.rawPrompt)
  const hasAuthPrompt = input.rawPrompt !== undefined && SENSITIVE_PATTERN.test(input.rawPrompt)
  const hasBlastRadius = (input.expectedFileCount ?? 0) >= 3

  const hasHighRiskSignal =
    hasProductionImpact ||
    hasReleaseImpact ||
    hasDataIntegrity ||
    hasSecuritySensitive ||
    hasDestructive ||
    hasMigrationInvolved ||
    hasConcurrencyInvolved ||
    hasAuth ||
    hasPackagePublication ||
    hasInfrastructureChange ||
    hasRollbackDifficulty ||
    hasExternalSideEffects ||
    hasIndependentReview ||
    hasDestructivePrompt ||
    hasAuthPrompt ||
    hasBlastRadius

  if (hasHighRiskSignal) {
    if (updatedRisk < HIGH_RISK_FLOOR) {
      updatedRisk = HIGH_RISK_FLOOR
      updatedEvidence.push({
        id: "score.risk.high_risk_minimum",
        source: "scoring.risk",
        detail: `high-risk signal floors risk to ${HIGH_RISK_FLOOR}`,
      })
    }
  }

  return { risk: updatedRisk, evidence: updatedEvidence }
}

/**
 * Computes the full ScoredTask for an input: complexity, ambiguity, risk
 * (after the high-risk minimum), and confidence, plus per-dimension evidence
 * and the policy/weights versions that produced them.
 */
export function computeTaskScores(input: ClassificationInput, weights: ScoreWeights = DEFAULT_WEIGHTS): ScoredTask {
  const complexityDimension = scoreComplexity(input, weights)
  const ambiguityDimension = scoreAmbiguity(input, weights)
  const riskDimension = scoreRisk(input, weights)
  const flooredRisk = ensureHighRiskMinimum(input, riskDimension.score, riskDimension.evidence)

  for (const score of [complexityDimension.score, ambiguityDimension.score, flooredRisk.risk]) {
    assertScoreRange(score)
  }

  const totalEvidence =
    complexityDimension.evidence.length + ambiguityDimension.evidence.length + flooredRisk.evidence.length
  const evidenceCoverage = Math.min(100, totalEvidence * 25)
  const confidence = clampScore(100 - (ambiguityDimension.score + 0.5 * (100 - evidenceCoverage)))
  assertScoreRange(confidence)

  // Build confidence evidence
  const confidenceEvidence: EvidenceReference[] = [
    {
      id: "score.confidence.ambiguity",
      source: "scoring.confidence",
      detail: `ambiguity ${ambiguityDimension.score} reduces confidence`,
    },
    {
      id: "score.confidence.evidence_coverage",
      source: "scoring.confidence",
      detail: `evidence coverage ${evidenceCoverage} (from ${totalEvidence} evidence items) adjusts confidence`,
    },
  ]

  const scores: TaskScores = {
    complexity: complexityDimension.score,
    ambiguity: ambiguityDimension.score,
    risk: flooredRisk.risk,
    confidence,
  }
  const parsed = zTaskScores.safeParse(scores)
  if (!parsed.success) {
    throw new Error(`computed task scores out of range: ${parsed.error.message}`)
  }

  return {
    scores,
    evidence: {
      complexity: complexityDimension.evidence,
      ambiguity: ambiguityDimension.evidence,
      risk: flooredRisk.evidence,
      confidence: confidenceEvidence,
    },
    weightsVersion: ROUTING_WEIGHTS_VERSION,
    policyVersion: ROUTING_POLICY_VERSION,
  }
}
