import type { HarnessFinding } from "../contracts/report";

export interface RegressionResult {
  regressedFindings: HarnessFinding[];
  newFindings: HarnessFinding[];
  resolvedFindings: HarnessFinding[];
}

export function detectRegressions(
  previousFindings: HarnessFinding[],
  currentFindings: HarnessFinding[],
): RegressionResult {
  const previousFingerprints = new Set(previousFindings.map((f) => f.id));
  const currentFingerprints = new Set(currentFindings.map((f) => f.id));

  const regressed: HarnessFinding[] = [];
  const resolved: HarnessFinding[] = [];
  const newFindings: HarnessFinding[] = [];

  for (const prev of previousFindings) {
    if (prev.status === "fixed" && currentFingerprints.has(prev.id)) {
      const current = currentFindings.find((f) => f.id === prev.id);
      if (current && current.status !== "fixed") {
        regressed.push(current);
      }
    }
    if (prev.status === "fixed" && !currentFingerprints.has(prev.id)) {
      resolved.push(prev);
    }
  }

  for (const curr of currentFindings) {
    if (!previousFingerprints.has(curr.id)) {
      newFindings.push(curr);
    }
  }

  return {
    regressedFindings: regressed,
    newFindings,
    resolvedFindings: resolved,
  };
}
