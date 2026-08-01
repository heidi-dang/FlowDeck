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
  isScoreInRange,
  SCORE_MIN,
  SCORE_MAX,
  type ClassificationInput,
} from "@/orchestration/routing/contracts"

describe("deterministic routing scorers", () => {
  it("scores a minimal input as zero across every dimension", () => {
    const input: ClassificationInput = { ambiguityLevel: 0, expectedFileCount: 0 }
    const scores = computeTaskScores(input)

    expect(scores.complexity).toBe(0)
    expect(scores.ambiguity).toBe(0)
    expect(scores.risk).toBe(0)
    for (const score of [scores.complexity, scores.ambiguity, scores.risk, scores.confidence]) {
      expect(isScoreInRange(score)).toBe(true)
    }
    expect(zTaskScores.safeParse(scores).success).toBe(true)
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
    const scores = computeTaskScores(input)

    expect(scores.complexity).toBe(100)
    expect(scores.risk).toBe(100)
    for (const score of [scores.complexity, scores.ambiguity, scores.risk, scores.confidence]) {
      expect(score).toBeLessThanOrEqual(SCORE_MAX)
      expect(score).toBeGreaterThanOrEqual(SCORE_MIN)
    }
    expect(zTaskScores.safeParse(scores).success).toBe(true)
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
      const scores = computeTaskScores(input)
      for (const score of [scores.complexity, scores.ambiguity, scores.risk, scores.confidence]) {
        expect(isScoreInRange(score)).toBe(true)
        expect(score).toBeGreaterThanOrEqual(SCORE_MIN)
        expect(score).toBeLessThanOrEqual(SCORE_MAX)
      }
      expect(zTaskScores.safeParse(scores).success).toBe(true)
    }
  })

  it("produces identical TaskScores across ten repeated calls", () => {
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
    expect(computeTaskScores({ productionImpact: 90 }).risk).toBeGreaterThanOrEqual(60)
    expect(computeTaskScores({ securitySensitive: true }).risk).toBeGreaterThanOrEqual(50)
    expect(computeTaskScores({ migrationInvolved: true }).risk).toBeGreaterThanOrEqual(50)
    expect(computeTaskScores({ releaseImpact: true }).risk).toBeGreaterThanOrEqual(50)
  })

  it("applies the high-risk floor only when it raises the risk", () => {
    const raised = ensureHighRiskMinimum({ productionImpact: 90 }, 30, [])
    expect(raised.risk).toBe(60)
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

    const scores = computeTaskScores(input)
    expect(scores.confidence).toBeLessThan(50)
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

  it("assertScoreRange throws for out-of-range scores", () => {
    expect(() => assertScoreRange(101)).toThrow("score out of range")
    expect(() => assertScoreRange(-1)).toThrow("score out of range")
    expect(() => assertScoreRange(0)).not.toThrow()
    expect(() => assertScoreRange(100)).not.toThrow()
  })
})
