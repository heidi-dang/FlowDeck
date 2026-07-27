import type { HarnessEvidence, HarnessFinding } from "../contracts/report";

export interface AnalysisResult {
  dimension: "controlled-execution";
  findings: HarnessFinding[];
}

export function analyzeControlledExecution(evidence: HarnessEvidence[]): AnalysisResult {
  const findings: HarnessFinding[] = [];
  const now = new Date().toISOString();

  // Check for pre-flight gates
  const hasCI = evidence.some(
    (e) => e.category === "foundation" && (e.summary.includes("CI/CD") || e.summary.includes("GitHub Actions")),
  );

  if (!hasCI) {
    findings.push({
      id: "ce_no_preflight",
      title: "No pre-flight execution gates detected",
      dimension: "controlled-execution",
      priority: "high",
      status: "pending",
      cause: "No CI workflow or pre-commit hooks configured",
      impact: "Code changes may skip validation before execution",
      expectedOutput: "Pre-flight gates ensuring controlled execution",
      evidence: evidence.filter((e) => e.category === "foundation" && e.source === "package.json"),
      recommendedVehicle: "ci-workflow",
      allowedPaths: [".github/workflows/"],
      validationRequirements: ["Create CI workflow with lint, typecheck, and test gates"],
      acceptanceCriteria: ["Lint, typecheck, and test pass before merge"],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  // Check for parallel execution safety
  const hasBuildScript = evidence.some(
    (e) => e.category === "foundation" && e.summary.includes("Build script"),
  );

  if (!hasBuildScript) {
    findings.push({
      id: "ce_no_build",
      title: "No build script defined",
      dimension: "controlled-execution",
      priority: "medium",
      status: "pending",
      cause: "package.json lacks a build script",
      impact: "Cannot validate compilation or bundle integrity",
      expectedOutput: "Defined build script in package.json",
      evidence: evidence.filter((e) => e.category === "foundation" && e.source === "package.json"),
      recommendedVehicle: "script",
      allowedPaths: ["package.json"],
      validationRequirements: ["Verify build script works"],
      acceptanceCriteria: ["`npm run build` (or equivalent) succeeds"],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  return { dimension: "controlled-execution", findings };
}
