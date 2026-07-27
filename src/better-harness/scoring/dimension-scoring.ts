import type { HarnessDimension } from "../contracts/common";
import type { HarnessDimensionScore, HarnessFinding } from "../contracts/report";

export interface DimensionScoreParams {
  dimension: HarnessDimension;
  findings: HarnessFinding[];
  evidenceCoverage: number;
  previousScore?: number;
}

export function scoreDimension(params: DimensionScoreParams): HarnessDimensionScore {
  const { dimension, findings, evidenceCoverage, previousScore } = params;

  const dimensionFindings = findings.filter((f) => f.dimension === dimension);

  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  for (const f of dimensionFindings) {
    if (f.priority === "high") highCount++;
    else if (f.priority === "medium") mediumCount++;
    else lowCount++;
  }

  // Base score
  let score = 100 - highCount * 18 - mediumCount * 8 - lowCount * 3;

  // Evidence coverage penalty (if coverage < 50%, apply penalty)
  if (evidenceCoverage < 50) {
    score -= Math.round((50 - evidenceCoverage) * 0.5);
  }

  // Recurring failure penalty (previous score was also low)
  if (previousScore !== undefined && previousScore < 50 && score < 70) {
    score -= 10;
  }

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  return {
    dimension,
    score,
    previousScore,
    findingCount: dimensionFindings.length,
    evidenceCoverage,
  };
}
