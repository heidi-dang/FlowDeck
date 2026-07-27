import type { HarnessEvidence, HarnessFinding } from "../contracts/report";

export interface AnalysisResult {
  dimension: "learning-capture";
  findings: HarnessFinding[];
}

export function analyzeLearningCapture(evidence: HarnessEvidence[]): AnalysisResult {
  const findings: HarnessFinding[] = [];
  const now = new Date().toISOString();

  const sessionEvidence = evidence.filter((e) => e.category === "session");

  // Check for session history
  if (sessionEvidence.every((e) => e.summary.includes("No session records"))) {
    findings.push({
      id: "lc_no_history",
      title: "No session history for learning",
      dimension: "learning-capture",
      priority: "medium",
      status: "pending",
      cause: "No session records available to analyze patterns",
      impact: "Cannot detect recurring issues or improvement opportunities",
      expectedOutput: "Session audit trail for pattern analysis",
      evidence: sessionEvidence,
      recommendedVehicle: "documentation",
      allowedPaths: [".opencode/"],
      validationRequirements: ["Enable session audit logging"],
      acceptanceCriteria: ["Session records are being persisted"],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  // Check for failed sessions
  const failedEvidence = evidence.filter((e) => e.summary.includes("failed sessions"));
  if (failedEvidence.length > 0) {
    findings.push({
      id: "lc_failed_sessions",
      title: "Recurring session failures detected",
      dimension: "learning-capture",
      priority: "high",
      status: "pending",
      cause: "Multiple sessions have failed or errored",
      impact: "Lessons from failures are not being captured",
      expectedOutput: "Lessons captured from failed sessions",
      evidence: failedEvidence,
      recommendedVehicle: "rule",
      allowedPaths: ["src/rules/"],
      validationRequirements: ["Analyze failure patterns", "Capture lessons learned"],
      acceptanceCriteria: ["Lessons are documented and actionable"],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  return { dimension: "learning-capture", findings };
}
