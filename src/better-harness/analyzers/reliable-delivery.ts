import { existsSync } from "fs";
import { join } from "path";
import type { HarnessEvidence, HarnessFinding } from "../contracts/report";

export interface AnalysisResult {
  dimension: "reliable-delivery";
  findings: HarnessFinding[];
}

export function analyzeReliableDelivery(evidence: HarnessEvidence[], root: string): AnalysisResult {
  const findings: HarnessFinding[] = [];
  const now = new Date().toISOString();

  const hasCI = evidence.some((e) => e.category === "foundation" && (e.summary.includes("CI/CD") || e.summary.includes("GitHub Actions")));
  const hasDocker = evidence.some((e) => e.category === "foundation" && e.source === "Dockerfile");

  if (!hasCI) {
    findings.push({
      id: "rd_no_ci",
      title: "No CI/CD pipeline configured",
      dimension: "reliable-delivery",
      priority: "high",
      status: "pending",
      cause: "No CI workflows or pipeline configuration found",
      impact: "Changes must be manually validated and deployed",
      expectedOutput: "Automated CI/CD pipeline",
      evidence: evidence.filter((e) => e.category === "foundation"),
      recommendedVehicle: "ci-workflow",
      allowedPaths: [".github/workflows/"],
      validationRequirements: ["Create CI pipeline with build, test, deploy stages"],
      acceptanceCriteria: ["CI pipeline runs on every push"],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  if (!hasDocker) {
    findings.push({
      id: "rd_no_container",
      title: "No containerization for deployment",
      dimension: "reliable-delivery",
      priority: "medium",
      status: "pending",
      cause: "No Dockerfile found",
      impact: "Deployment environment may differ from development",
      expectedOutput: "Dockerfile for consistent deployment",
      evidence: [],
      recommendedVehicle: "script",
      allowedPaths: ["Dockerfile"],
      validationRequirements: ["Create Dockerfile"],
      acceptanceCriteria: ["Docker build succeeds"],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  // Check rollback capability
  if (!existsSync(join(root, "rollback"))) {
    findings.push({
      id: "rd_no_rollback",
      title: "No rollback documentation or scripts",
      dimension: "reliable-delivery",
      priority: "medium",
      status: "pending",
      cause: "No rollback plan or scripts found",
      impact: "Failed deployments cannot be quickly reverted",
      expectedOutput: "Rollback documentation or script",
      evidence: [],
      recommendedVehicle: "documentation",
      allowedPaths: ["docs/"],
      validationRequirements: ["Document rollback procedure"],
      acceptanceCriteria: ["Rollback procedure is documented"],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  return { dimension: "reliable-delivery", findings };
}
