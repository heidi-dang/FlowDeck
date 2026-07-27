import type { HarnessFinding } from "../contracts/report";
import { buildRepairPrompt } from "./repair-prompt";

export interface RepairSessionRequest {
  finding: HarnessFinding;
  projectPath: string;
}

export interface RepairSessionResponse {
  repairSessionId: string;
  prompt: string;
}

export function createRepairSession(request: RepairSessionRequest): RepairSessionResponse {
  const { finding, projectPath } = request;

  const prompt = buildRepairPrompt({
    finding,
    projectPath,
  });

  const repairSessionId = `repair_${finding.id}_${Date.now()}`;

  return {
    repairSessionId,
    prompt,
  };
}

export function generateRestrictedRepairPrompt(
  cause: string,
  evidence: string[],
  expectedOutput: string,
  allowedPaths: string[],
  validationRequirements: string[],
  acceptanceCriteria: string[],
): string {
  return `## Cause
${cause}

## Evidence
${evidence.map((e) => `- ${e}`).join("\n")}

## Expected Output
${expectedOutput}

## Prohibited Changes
You are restricted to the following paths: ${allowedPaths.join(", ")}
Do NOT modify files outside these paths.

## Validation Requirements
${validationRequirements.map((v, i) => `${i + 1}. ${v}`).join("\n")}

## Acceptance Criteria
${acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join("\n")}
`;
}
