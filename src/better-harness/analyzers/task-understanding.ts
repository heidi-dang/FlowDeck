import type { HarnessEvidence, HarnessFinding } from "../contracts/report";

export interface AnalysisResult {
  dimension: "task-understanding";
  findings: HarnessFinding[];
}

export function analyzeTaskUnderstanding(evidence: HarnessEvidence[]): AnalysisResult {
  const findings: HarnessFinding[] = [];
  const now = new Date().toISOString();

  // Check for conflicting agent instructions
  const agentInstructions = evidence.filter(
    (e) => e.category === "customization" && (e.source.includes("AGENTS") || e.source.includes("CLAUDE") || e.source.includes("GEMINI")),
  );

  if (agentInstructions.length > 1) {
    findings.push({
      id: "tu_conflicting_instructions",
      title: "Multiple agent instruction files may conflict",
      dimension: "task-understanding",
      priority: "high",
      status: "pending",
      cause: `Found ${agentInstructions.length} instruction files: ${agentInstructions.map((e) => e.source).join(", ")}`,
      impact: "Agent may receive contradictory instructions, causing inconsistent behavior",
      expectedOutput: "Single source of truth for agent instructions",
      evidence: agentInstructions,
      recommendedVehicle: "rule",
      allowedPaths: [".opencode/"],
      validationRequirements: ["Verify no duplicate instructions exist"],
      acceptanceCriteria: ["Only one primary instruction file is active"],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  // Missing task context
  const noSessionEvidence = evidence.filter(
    (e) => e.category === "session" && e.summary.includes("No session records"),
  );
  if (noSessionEvidence.length > 0) {
    findings.push({
      id: "tu_missing_context",
      title: "No session history available for context",
      dimension: "task-understanding",
      priority: "medium",
      status: "pending",
      cause: "No session records found in .opencode/ directory",
      impact: "Engine cannot assess historical task context or learning patterns",
      expectedOutput: "Session records for context analysis",
      evidence: noSessionEvidence,
      recommendedVehicle: "documentation",
      allowedPaths: [".opencode/"],
      validationRequirements: ["Verify OpenCode audit logging is enabled"],
      acceptanceCriteria: ["Session audit trail is available"],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  return { dimension: "task-understanding", findings };
}
