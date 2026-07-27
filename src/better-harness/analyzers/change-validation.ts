import type { HarnessEvidence, HarnessFinding } from "../contracts/report";

export interface AnalysisResult {
  dimension: "change-validation";
  findings: HarnessFinding[];
}

export function analyzeChangeValidation(evidence: HarnessEvidence[]): AnalysisResult {
  const findings: HarnessFinding[] = [];
  const now = new Date().toISOString();

  const hasLint = evidence.some((e) => e.category === "foundation" && e.summary.includes("Lint script"));
  const hasTest = evidence.some((e) => e.category === "foundation" && e.summary.includes("Test script"));
  const hasTypecheck = evidence.some((e) => e.category === "foundation" && e.summary.includes("type checking"));

  if (!hasLint) {
    findings.push({
      id: "cv_no_lint",
      title: "No linting configured for change validation",
      dimension: "change-validation",
      priority: "high",
      status: "pending",
      cause: "package.json does not include a lint script",
      impact: "Code quality issues may go undetected",
      expectedOutput: "Lint script in package.json",
      evidence: evidence.filter((e) => e.category === "foundation" && e.source === "package.json"),
      recommendedVehicle: "script",
      allowedPaths: ["package.json"],
      validationRequirements: ["Add and configure linter"],
      acceptanceCriteria: ["Lint passes on all files"],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  if (!hasTest) {
    findings.push({
      id: "cv_no_test",
      title: "No tests configured",
      dimension: "change-validation",
      priority: "high",
      status: "pending",
      cause: "package.json does not include a test script",
      impact: "Changes cannot be validated for regressions",
      expectedOutput: "Test script in package.json",
      evidence: evidence.filter((e) => e.category === "foundation" && e.source === "package.json"),
      recommendedVehicle: "script",
      allowedPaths: ["package.json"],
      validationRequirements: ["Add test framework and initial tests"],
      acceptanceCriteria: ["Tests run and pass"],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  if (!hasTypecheck) {
    findings.push({
      id: "cv_no_typecheck",
      title: "No type checking configured",
      dimension: "change-validation",
      priority: "medium",
      status: "pending",
      cause: "No typecheck script in package.json",
      impact: "Type errors may reach production",
      expectedOutput: "Type check script in package.json",
      evidence: evidence.filter((e) => e.category === "foundation" && e.source === "package.json"),
      recommendedVehicle: "script",
      allowedPaths: ["package.json"],
      validationRequirements: ["Configure TypeScript strict mode"],
      acceptanceCriteria: ["Type check passes"],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  return { dimension: "change-validation", findings };
}
