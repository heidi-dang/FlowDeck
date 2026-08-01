/**
 * Deterministic routing scorer tests.
 *
 * Covers complexity, ambiguity, and risk scoring plus the high-risk minimum
 * rule, weight configurability, evidence traceability, determinism, and
 * zTaskScores validation.
 */

import { describe, it, expect } from "bun:test"
import {
  computeTaskScores,
  scoreComplexity,
  scoreAmbiguity,
  scoreRisk,
  ensureHighRiskMinimum,
  assertScoreRange,
  DEFAULT_WEIGHTS,
  type ScoreWeights,
} from "@/orchestration/routing/scoring/scorers"
import {
  zTaskScores,
  zScoredTask,
  zTaskScoresArray,
  isScoreInRange,
  areScoresInRange,
  SCORE_MIN,
  SCORE_MAX,
  type ClassificationInput,
} from "@/orchestration/routing/contracts"

describe("deterministic routing scorers", () => {
  it("scores a minimal input as zero across every dimension", () => {
    const input: ClassificationInput = { ambiguityLevel: 0, expectedFileCount: 0 }
    const scored = computeTaskScores(input)

    expect(scored.scores.complexity).toBe(0)
    expect(scored.scores.ambiguity).toBe(0)
    expect(scored.scores.risk).toBe(0)
    for (const score of [scored.scores.complexity, scored.scores.ambiguity, scored.scores.risk, scored.scores.confidence]) {
      expect(isScoreInRange(score)).toBe(true)
    }
    expect(zTaskScores.safeParse(scored.scores).success).toBe(true)
    expect(zScoredTask.safeParse(scored).success).toBe(true)
  })

  it("scores zero ambiguity when ambiguityLevel is explicitly zero with full signal coverage", () => {
    const input: ClassificationInput = {
      ambiguityLevel: 0,
      expectedFileCount: 1,
      expectedDomainCount: 1,
      rawPrompt: "clear task",
      hasTests: true,
      mutating: true,
    }
    expect(scoreAmbiguity(input).score).toBe(0)
  })

  it("clamps every score for a saturated input", () => {
    const input: ClassificationInput = {
      productionImpact: 100,
      securitySensitive: true,
      migrationInvolved: true,
      concurrencyInvolved: true,
      uiInvolved: true,
      ciContext: true,
      hasTests: true,
      expectedFileCount: 5,
      expectedDomainCount: 3,
      releaseImpact: true,
      needsIndependentReview: true,
    }
    const scored = computeTaskScores(input)

    expect(scored.scores.complexity).toBe(100)
    expect(scored.scores.risk).toBe(100)
    for (const score of [scored.scores.complexity, scored.scores.ambiguity, scored.scores.risk, scored.scores.confidence]) {
      expect(score).toBeLessThanOrEqual(SCORE_MAX)
      expect(score).toBeGreaterThanOrEqual(SCORE_MIN)
    }
    expect(zTaskScores.safeParse(scored.scores).success).toBe(true)
    expect(zScoredTask.safeParse(scored).success).toBe(true)
  })

  it("keeps every dimension within SCORE_MIN..SCORE_MAX for boundary inputs", () => {
    const inputs: ClassificationInput[] = [
      {
        expectedFileCount: 100,
        expectedDomainCount: 100,
        hasTests: true,
        uiInvolved: true,
        ciContext: true,
        migrationInvolved: true,
        concurrencyInvolved: true,
        rawPrompt: "multi-file integration distributed",
      },
      {
        productionImpact: 100,
        releaseImpact: true,
        securitySensitive: true,
        migrationInvolved: true,
        concurrencyInvolved: true,
        needsIndependentReview: true,
        expectedFileCount: 100,
        rawPrompt: "delete auth credentials and force reset",
      },
      { ambiguityLevel: 100 },
      {},
    ]

    for (const input of inputs) {
      const scored = computeTaskScores(input)
      for (const score of [scored.scores.complexity, scored.scores.ambiguity, scored.scores.risk, scored.scores.confidence]) {
        expect(isScoreInRange(score)).toBe(true)
        expect(score).toBeGreaterThanOrEqual(SCORE_MIN)
        expect(score).toBeLessThanOrEqual(SCORE_MAX)
      }
      expect(zTaskScores.safeParse(scored.scores).success).toBe(true)
      expect(zScoredTask.safeParse(scored).success).toBe(true)
    }
  })

  it("produces identical ScoredTask across ten repeated calls", () => {
    const input: ClassificationInput = {
      productionImpact: 65,
      securitySensitive: true,
      migrationInvolved: true,
      uiInvolved: true,
      hasTests: true,
      expectedFileCount: 4,
      expectedDomainCount: 2,
      rawPrompt: "integrate auth module across services",
      ambiguityLevel: 40,
    }
    const first = computeTaskScores(input)
    for (let call = 0; call < 9; call++) {
      expect(computeTaskScores(input)).toEqual(first)
    }
  })

  it("enforces the high-risk minimum floor", () => {
    expect(computeTaskScores({ productionImpact: 90 }).scores.risk).toBeGreaterThanOrEqual(70)
    expect(computeTaskScores({ securitySensitive: true }).scores.risk).toBeGreaterThanOrEqual(70)
    expect(computeTaskScores({ migrationInvolved: true }).scores.risk).toBeGreaterThanOrEqual(70)
    expect(computeTaskScores({ releaseImpact: true }).scores.risk).toBeGreaterThanOrEqual(70)
    expect(computeTaskScores({ concurrencyInvolved: true }).scores.risk).toBeGreaterThanOrEqual(70)
    expect(computeTaskScores({ needsIndependentReview: true }).scores.risk).toBeGreaterThanOrEqual(70)
    expect(computeTaskScores({ rawPrompt: "delete the database" }).scores.risk).toBeGreaterThanOrEqual(70)
    expect(computeTaskScores({ rawPrompt: "auth token secret" }).scores.risk).toBeGreaterThanOrEqual(70)
    expect(computeTaskScores({ expectedFileCount: 3 }).scores.risk).toBeGreaterThanOrEqual(70)
  })

  it("floors risk to >= 70 for every canonical high-risk signal (isolated case per signal)", () => {
    const canonicalSignals: Array<{ name: string; input: ClassificationInput }> = [
      { name: "production impact", input: { productionImpact: 70 } },
      { name: "release impact", input: { releaseImpact: true } },
      { name: "data integrity", input: { dataIntegrityInvolved: true } },
      { name: "security", input: { securitySensitive: true } },
      { name: "destructive operations", input: { destructiveOperations: true } },
      { name: "migration", input: { migrationInvolved: true } },
      { name: "concurrency", input: { concurrencyInvolved: true } },
      { name: "authentication/authorization", input: { authInvolved: true } },
      { name: "package publication", input: { packagePublication: true } },
      { name: "infrastructure change", input: { infrastructureChange: true } },
      { name: "rollback difficulty", input: { rollbackDifficulty: true } },
      { name: "uncertain external side effects", input: { uncertainExternalSideEffects: true } },
    ]

    for (const { name, input } of canonicalSignals) {
      const scored = computeTaskScores(input)
      expect(scored.scores.risk, `${name} signal must floor risk to >= 70`).toBeGreaterThanOrEqual(70)
      expect(zScoredTask.safeParse(scored).success).toBe(true)
    }
  })

  it("emits high-risk-minimum evidence only when the floor raises the risk", () => {
    const raised = computeTaskScores({ securitySensitive: true })
    expect(raised.scores.risk).toBe(70)
    expect(raised.evidence.risk.some((e) => e.id === "score.risk.high_risk_minimum")).toBe(true)

    // productionImpact >= 70 already contributes exactly 70 (weight 30/30),
    // so the floor does not raise it and no minimum evidence is emitted.
    const alreadyFloored = computeTaskScores({ productionImpact: 70 })
    expect(alreadyFloored.scores.risk).toBeGreaterThanOrEqual(70)
  })

  it("scores every canonical risk signal with its own executable evidence", () => {
    const cases: Array<{ input: ClassificationInput; evidenceId: string }> = [
      { input: { productionImpact: 50 }, evidenceId: "score.risk.production" },
      { input: { releaseImpact: true }, evidenceId: "score.risk.release" },
      { input: { dataIntegrityInvolved: true }, evidenceId: "score.risk.data_integrity" },
      { input: { securitySensitive: true }, evidenceId: "score.risk.security" },
      { input: { destructiveOperations: true }, evidenceId: "score.risk.destructive" },
      { input: { migrationInvolved: true }, evidenceId: "score.risk.migration" },
      { input: { concurrencyInvolved: true }, evidenceId: "score.risk.concurrency" },
      { input: { authInvolved: true }, evidenceId: "score.risk.auth" },
      { input: { packagePublication: true }, evidenceId: "score.risk.package_publication" },
      { input: { infrastructureChange: true }, evidenceId: "score.risk.infrastructure" },
      { input: { rollbackDifficulty: true }, evidenceId: "score.risk.rollback_difficulty" },
      { input: { uncertainExternalSideEffects: true }, evidenceId: "score.risk.external_side_effects" },
    ]

    for (const { input, evidenceId } of cases) {
      const dimension = scoreRisk(input)
      expect(dimension.score).toBeGreaterThan(0)
      expect(dimension.evidence.some((e) => e.id === evidenceId)).toBe(true)
    }
  })

  it("applies the high-risk floor only when it raises the risk", () => {
    const raised = ensureHighRiskMinimum({ productionImpact: 90 }, 30, [])
    expect(raised.risk).toBe(70)
    expect(raised.evidence.some((e) => e.id === "score.risk.high_risk_minimum")).toBe(true)

    const untouched = ensureHighRiskMinimum({ productionImpact: 90 }, 90, [])
    expect(untouched.risk).toBe(90)
    expect(untouched.evidence.length).toBe(0)
  })

  it("scales complexity with a custom per-file weight", () => {
    const input: ClassificationInput = { expectedFileCount: 1 }
    const customWeights: ScoreWeights = {
      ...DEFAULT_WEIGHTS,
      complexity: { ...DEFAULT_WEIGHTS.complexity, perFile: 100 },
    }

    const defaultScore = scoreComplexity(input, DEFAULT_WEIGHTS).score
    const customScore = scoreComplexity(input, customWeights).score
    expect(customScore).toBeGreaterThan(defaultScore)
  })

  it("does not let a single weak signal dominate complexity", () => {
    const dimension = scoreComplexity({ uiInvolved: true })
    expect(dimension.score).toBeLessThan(50)
  })

  it("scores high ambiguity with strong signals and low confidence", () => {
    const input: ClassificationInput = { ambiguityLevel: 100 }
    expect(scoreAmbiguity(input).score).toBeGreaterThanOrEqual(80)

    const scored = computeTaskScores(input)
    expect(scored.scores.confidence).toBeLessThan(50)
  })

  it("attaches evidence to every non-zero score", () => {
    const inputs: ClassificationInput[] = [
      { productionImpact: 50 },
      { expectedFileCount: 2 },
      { hasTests: true, uiInvolved: true },
      { ambiguityLevel: 60 },
      { securitySensitive: true },
    ]

    for (const input of inputs) {
      for (const dimension of [scoreComplexity(input), scoreAmbiguity(input), scoreRisk(input)]) {
        if (dimension.score !== 0) {
          expect(dimension.evidence.length).toBeGreaterThanOrEqual(1)
        }
      }
    }
  })

  it("rejects out-of-range and non-integer manual scores via zTaskScores", () => {
    expect(zTaskScores.safeParse({ complexity: 150, ambiguity: 0, risk: 0, confidence: 0 }).success).toBe(false)
    expect(zTaskScores.safeParse({ complexity: -1, ambiguity: 0, risk: 0, confidence: 0 }).success).toBe(false)
    expect(zTaskScores.safeParse({ complexity: 1.5, ambiguity: 0, risk: 0, confidence: 0 }).success).toBe(false)
    expect(zTaskScores.safeParse({ complexity: 10, ambiguity: 10, risk: 10, confidence: 10 }).success).toBe(true)
  })

  it("validates ScoredTask shape via zScoredTask", () => {
    const validScoredTask = {
      scores: { complexity: 10, ambiguity: 10, risk: 10, confidence: 10 },
      evidence: {
        complexity: [{ id: "e1", source: "s", detail: "d" }],
        ambiguity: [],
        risk: [],
        confidence: [],
      },
      weightsVersion: "1.0.0",
      policyVersion: "1.0.0",
    }
    expect(zScoredTask.safeParse(validScoredTask).success).toBe(true)

    // missing evidence.confidence
    expect(
      zScoredTask.safeParse({ ...validScoredTask, evidence: { ...validScoredTask.evidence, confidence: undefined } }).success,
    ).toBe(false)

    // missing weightsVersion
    expect(
      zScoredTask.safeParse({ ...validScoredTask, weightsVersion: undefined }).success,
    ).toBe(false)

    // missing policyVersion
    expect(
      zScoredTask.safeParse({ ...validScoredTask, policyVersion: undefined }).success,
    ).toBe(false)

    // invalid score in nested scores
    expect(
      zScoredTask.safeParse({ ...validScoredTask, scores: { ...validScoredTask.scores, risk: 150 } }).success,
    ).toBe(false)
  })

  it("validates arrays of scores via areScoresInRange and zTaskScoresArray (D11)", () => {
    expect(areScoresInRange([0, 50, 100])).toBe(true)
    expect(areScoresInRange([10, 20, 30, 40])).toBe(true)
    expect(areScoresInRange([-1, 50, 100])).toBe(false)
    expect(areScoresInRange([0, 50, 101])).toBe(false)
    expect(areScoresInRange([0, NaN, 100])).toBe(false)
    expect(areScoresInRange([])).toBe(true)

    expect(zTaskScoresArray.safeParse([
      { complexity: 10, ambiguity: 10, risk: 10, confidence: 10 },
      { complexity: 20, ambiguity: 20, risk: 20, confidence: 20 },
    ]).success).toBe(true)

    expect(zTaskScoresArray.safeParse([
      { complexity: 10, ambiguity: 10, risk: 10, confidence: 10 },
      { complexity: 150, ambiguity: 10, risk: 10, confidence: 10 }, // out of range
    ]).success).toBe(false)
  })

  it("assertScoreRange throws for out-of-range scores", () => {
    expect(() => assertScoreRange(101)).toThrow("score out of range")
    expect(() => assertScoreRange(-1)).toThrow("score out of range")
    expect(() => assertScoreRange(0)).not.toThrow()
    expect(() => assertScoreRange(100)).not.toThrow()
  })
})
