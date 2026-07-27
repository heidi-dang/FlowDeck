import { createHash } from "crypto";
import type { HarnessFinding } from "../contracts/report";


function generateFindingId(
  dimension: string,
  cause: string,
  allowedPaths: string[],
  recommendedVehicle: string,
): string {
  const normalized = `${dimension}|${cause.toLowerCase().trim()}|${allowedPaths.join(",")}|${recommendedVehicle}`;
  return `fnd_${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

export function synthesizeFindings(
  dimensionResults: Array<{dimension: string; findings: HarnessFinding[]}>,
): HarnessFinding[] {
  const allFindings: HarnessFinding[] = [];

  for (const result of dimensionResults) {
    for (const finding of result.findings) {
      const stableId = generateFindingId(
        finding.dimension,
        finding.cause,
        finding.allowedPaths,
        finding.recommendedVehicle,
      );
      allFindings.push({
        ...finding,
        id: stableId,
      });
    }
  }

  return allFindings;
}
