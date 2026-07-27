import type { HarnessDimensionScore } from "../contracts/report";

export function getScoreTrend(
  currentScore: number,
  previousScore: number | undefined
): "improvement" | "decline" | "stable" | "first-run" {
  if (previousScore === undefined) {
    return "first-run";
  }
  const diff = currentScore - previousScore;
  if (Math.abs(diff) <= 5) {
    return "stable";
  }
  return diff > 0 ? "improvement" : "decline";
}

export function calculateOverallScore(
  dimensionScores: HarnessDimensionScore[],
  _previousOverallScore?: number
): { overallScore: number; evidenceCoverage: number } {
  if (dimensionScores.length === 0) {
    return { overallScore: 0, evidenceCoverage: 0 };
  }

  const weights: Record<string, number> = {
    "task-understanding": 1.0,
    "controlled-execution": 1.0,
    "change-validation": 1.0,
    "reliable-delivery": 1.0,
    "learning-capture": 1.0,
  };

  let totalWeight = 0;
  let weightedSum = 0;
  let totalCoverage = 0;

  for (const ds of dimensionScores) {
    const w = weights[ds.dimension] ?? 1.0;
    weightedSum += ds.score * w;
    totalWeight += w;
    totalCoverage += ds.evidenceCoverage;
  }

  return {
    overallScore: totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0,
    evidenceCoverage: dimensionScores.length > 0 ? Math.round(totalCoverage / dimensionScores.length) : 0,
  };
}
