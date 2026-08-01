/**
 * Repeated-run consistency tests for the routing decision layer.
 *
 * Goal: the Dev 4 program requires "equivalent routing across repeated runs"
 * of at least 90% for comparable tasks. Because the classifier and the
 * scorers are pure and deterministic, repeated runs must be 100%
 * equivalent — this suite proves that with five runs per fixture.
 *
 * These tests cover the PR 1 components (classification, scores, confidence,
 * serialization). Strategy, delegation, scheduling, and model-tier
 * comparisons join this suite as those components land in stacked Dev 4
 * milestones.
 */
import { describe, it, expect } from "bun:test";
import {
  classifyTask,
  classifyWithConsistency,
  DEFAULT_CLASSIFICATION_THRESHOLD,
} from "@/orchestration/routing/classifier/classifier";
import {
  computeTaskScores,
  DEFAULT_WEIGHTS,
} from "@/orchestration/routing/scoring/scorers";
import {
  canonicalJson,
  parseCanonicalJson,
  zClassificationResult,
  zScoredTask,
  zStrategyPolicy,
  DEFAULT_STRATEGY_POLICIES,
  getStrategyPolicy,
  type ClassificationInput,
  type ClassificationResult,
} from "@/orchestration/routing/contracts";

const FIXTURES: Array<{ name: string; input: ClassificationInput }> = [
  { name: "trivial_edit", input: { expectedFileCount: 1, hasTests: false, expectedDomainCount: 0 } },
  { name: "documentation", input: { rawPrompt: "write documentation for the API", readOnly: true } },
  { name: "read_only_question", input: { readOnly: true, mutating: false } },
  { name: "repository_audit", input: { explicitAuditRequest: true, securitySensitive: false } },
  { name: "local_bug", input: { hasTests: true, expectedFileCount: 1, ambiguityLevel: 10 } },
  { name: "cross_module_feature", input: { expectedFileCount: 5, expectedDomainCount: 3, hasTests: true } },
  { name: "ci_failure", input: { ciContext: true } },
  { name: "build_package_failure", input: { ciContext: true, buildOrPackageFailure: true } },
  { name: "release_failure", input: { ciContext: true, releaseImpact: true } },
  { name: "database_migration", input: { migrationInvolved: true } },
  { name: "concurrency_failure", input: { concurrencyInvolved: true } },
  { name: "security_review", input: { securitySensitive: true } },
  { name: "performance_work", input: { rawPrompt: "improve latency of the hot path" } },
  { name: "ui_feature", input: { uiInvolved: true, expectedFileCount: 2 } },
  { name: "production_incident", input: { productionImpact: 90 } },
  { name: "recovery_resume", input: { recoveryState: true } },
  { name: "unknown", input: {} },
];

const RUNS = 5;

describe("routing consistency: classification across repeated runs", () => {
  it("classifies every fixture identically across five runs", () => {
    for (const fixture of FIXTURES) {
      const results = classifyWithConsistency(
        fixture.input,
        fixture.input,
        fixture.input,
        fixture.input,
        fixture.input,
      );
      expect(results).toHaveLength(RUNS);
      for (const result of results) {
        expect(result).toEqual(results[0]);
        const parsed = zClassificationResult.safeParse(result);
        expect(parsed.success).toBe(true);
      }
    }
  });

  it("produces byte-identical canonical serialization across runs", () => {
    for (const fixture of FIXTURES) {
      const json = canonicalJson(classifyTask(fixture.input));
      for (let i = 0; i < RUNS; i++) {
        expect(canonicalJson(classifyTask(fixture.input))).toBe(json);
      }
    }
  });

  it("reaches 100% classification equivalence (target >= 90%)", () => {
    let equivalent = 0;
    for (const fixture of FIXTURES) {
      const first = classifyTask(fixture.input);
      let same = true;
      for (let i = 0; i < RUNS; i++) {
        if (JSON.stringify(classifyTask(fixture.input)) !== JSON.stringify(first)) {
          same = false;
        }
      }
      if (same) equivalent += 1;
    }
    const ratio = (equivalent / FIXTURES.length) * 100;
    expect(ratio).toBeGreaterThanOrEqual(90);
    expect(ratio).toBe(100);
  });
});

describe("routing consistency: scores across repeated runs", () => {
  it("computes identical ScoredTask across five runs for every fixture", () => {
    for (const fixture of FIXTURES) {
      const first = computeTaskScores(fixture.input, DEFAULT_WEIGHTS);
      const parsed = zScoredTask.safeParse(first);
      expect(parsed.success).toBe(true);
      for (let i = 0; i < RUNS; i++) {
        expect(computeTaskScores(fixture.input, DEFAULT_WEIGHTS)).toEqual(first);
      }
    }
  });

  it("keeps classification and scoring jointly deterministic", () => {
    for (const fixture of FIXTURES) {
      const joined = () =>
        canonicalJson({
          classification: classifyTask(fixture.input),
          scores: computeTaskScores(fixture.input, DEFAULT_WEIGHTS),
        });
      const first = joined();
      for (let i = 0; i < RUNS; i++) {
        expect(joined()).toBe(first);
      }
    }
  });
});

describe("routing consistency: serialization round-trip", () => {
  it("round-trips a full decision payload through canonical JSON", () => {
    const payload = {
      classification: classifyTask(FIXTURES[10].input), // concurrency_failure
      scores: computeTaskScores(FIXTURES[10].input, DEFAULT_WEIGHTS),
    };
    const json = canonicalJson(payload);
    for (let i = 0; i < RUNS; i++) {
      expect(canonicalJson(payload)).toBe(json);
    }
    const revived = parseCanonicalJson<{
      classification: ClassificationResult;
      scores: { scores: { complexity: number; ambiguity: number; risk: number; confidence: number } };
    }>(json);
    expect(revived.classification.taskClass).toBe("concurrency_failure");
    expect(revived.scores.scores.risk).toBe(payload.scores.scores.risk);
  });

  it("marks confident classifications as not needing a model fallback, consistently", () => {
    for (const fixture of FIXTURES) {
      const results: ClassificationResult[] = [];
      for (let i = 0; i < RUNS; i++) {
        results.push(classifyTask(fixture.input));
      }
      const first = results[0];
      const fallbackVerdicts = results.map(
        (r) =>
          r.taskClass === "unknown" || r.confidence < DEFAULT_CLASSIFICATION_THRESHOLD,
      );
      for (const verdict of fallbackVerdicts) {
        expect(verdict).toBe(
          first.taskClass === "unknown" ||
            first.confidence < DEFAULT_CLASSIFICATION_THRESHOLD,
        );
      }
    }
  });
});

describe("routing consistency: strategy policies deep-frozen (D13)", () => {
  it("DEFAULT_STRATEGY_POLICIES is deeply frozen", () => {
    expect(Object.isFrozen(DEFAULT_STRATEGY_POLICIES)).toBe(true)
    for (const policy of Object.values(DEFAULT_STRATEGY_POLICIES)) {
      expect(Object.isFrozen(policy)).toBe(true)
      expect(Object.isFrozen(policy.allowedStates)).toBe(true)
      expect(Object.isFrozen(policy.requiredCapabilities)).toBe(true)
      expect(Object.isFrozen(policy.approvalRequirements)).toBe(true)
    }
  })

  it("getStrategyPolicy returns a mutable deep clone", () => {
    const policy = getStrategyPolicy("fast_direct")
    expect(Object.isFrozen(policy)).toBe(false)
    expect(Object.isFrozen(policy.allowedStates)).toBe(false)

    // Mutating the clone should not affect the frozen original
    policy.allowedStates.push("review")
    const original = DEFAULT_STRATEGY_POLICIES.fast_direct
    expect(original.allowedStates).not.toContain("review")
  })

  it("strategy policies validate via zStrategyPolicy", () => {
    for (const policy of Object.values(DEFAULT_STRATEGY_POLICIES)) {
      expect(zStrategyPolicy.safeParse(policy).success).toBe(true)
    }
  })
})
