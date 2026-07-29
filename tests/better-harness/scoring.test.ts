import { describe, it, expect } from "bun:test";
import { scoreDimension } from "../../src/better-harness/scoring/dimension-scoring";
import { calculateOverallScore } from "../../src/better-harness/scoring/overall-scoring";

describe("Dimension Scoring Edge Cases", () => {
  it("handles no findings gracefully", () => {
    const result = scoreDimension({
      dimension: "learning-capture",
      findings: [],
      evidenceCoverage: 0,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("penalizes low evidence coverage", () => {
    const withCoverage = scoreDimension({
      dimension: "controlled-execution",
      findings: [],
      evidenceCoverage: 90,
    });
    const withoutCoverage = scoreDimension({
      dimension: "controlled-execution",
      findings: [],
      evidenceCoverage: 10,
    });
    expect(withCoverage.score).toBeGreaterThan(withoutCoverage.score);
  });

  it("applies recurring failure penalty for low previous scores", () => {
    const result = scoreDimension({
      dimension: "task-understanding",
      findings: Array.from({ length: 2 }, (_, i) => ({
        id: `fnd_${i}`, title: "", dimension: "task-understanding" as const,
        priority: "high" as const, status: "pending" as const,
        cause: "", impact: "", expectedOutput: "",
        evidence: [], recommendedVehicle: "rule" as const,
        allowedPaths: [], validationRequirements: [], acceptanceCriteria: [],
        firstSeenAt: "", lastSeenAt: "",
      })) as any,
      evidenceCoverage: 100,
      previousScore: 30,
    });
    // 100 - 36 = 64, then -10 recurrent penalty = 54
    expect(result.score).toBe(54);
  });
});

describe("Overall Scoring Edge Cases", () => {
  it("handles single dimension", () => {
    const { overallScore } = calculateOverallScore([
      { dimension: "task-understanding" as const, score: 50, findingCount: 5, evidenceCoverage: 50 },
    ]);
    expect(overallScore).toBeGreaterThanOrEqual(0);
    expect(overallScore).toBeLessThanOrEqual(100);
  });
});
