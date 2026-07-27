import type { HarnessFinding } from "../contracts/report";

export interface RepairPromptConfig {
  finding: HarnessFinding;
  projectPath: string;
  previousAttempts?: number;
}

export function buildRepairPrompt(config: RepairPromptConfig): string {
  const { finding, projectPath, previousAttempts } = config;

  const prohibitedChanges = finding.allowedPaths.length > 0
    ? finding.allowedPaths.join(", ")
    : "No specific path restrictions";

  return `You are performing a targeted repair in ${projectPath}.

## Finding
**${finding.title}**
Cause: ${finding.cause}
Impact: ${finding.impact}

## Expected Output
${finding.expectedOutput}

## Evidence
${finding.evidence.map((e) => `- [${e.source}] ${e.summary}`).join("\n")}

## Validation Requirements
${finding.validationRequirements.map((v, i) => `${i + 1}. ${v}`).join("\n")}

## Acceptance Criteria
${finding.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join("\n")}

## Prohibited Changes
You are restricted to the following paths: ${prohibitedChanges}
Do NOT modify files outside these paths.
Do NOT change configurations, dependencies, or infrastructure unless explicitly required.

## Repair Instructions
1. Analyze the root cause
2. Implement the minimal fix
3. Validate against acceptance criteria
4. Do not make cosmetic or scope-creep changes
${previousAttempts ? `\nNote: This is attempt #${previousAttempts + 1}. Previous attempts did not fully resolve the issue.` : ""}
`;
}
