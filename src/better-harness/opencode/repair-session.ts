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

export interface OpenCodeClientLike {
  createSession: (config: { prompt: string; restrictedPaths: string[] }) => Promise<string>;
}

export function createRepairSession(
  request: RepairSessionRequest,
  opencodeClient?: OpenCodeClientLike,
): RepairSessionResponse {
  const { finding, projectPath } = request;

  const prompt = buildRepairPrompt({
    finding,
    projectPath,
  });

  const repairSessionId = "repair_" + finding.id + "_" + Date.now();

  // Use opencode client if available
  if (opencodeClient && opencodeClient.createSession) {
    // The async creation is fire-and-forget; the ID is returned immediately
    opencodeClient.createSession({
      prompt,
      restrictedPaths: finding.allowedPaths,
    }).then((_sessionId) => {
      // session created successfully
    }).catch(() => {
      // fallback to synthetic ID
    });
  }

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
  return "## Cause\n" +
cause + "\n\n" +
"## Evidence\n" +
evidence.map((e) => "- " + e).join("\n") + "\n\n" +
"## Expected Output\n" +
expectedOutput + "\n\n" +
"## Prohibited Changes\n" +
"You are restricted to the following paths: " + allowedPaths.join(", ") + "\n" +
"Do NOT modify files outside these paths.\n\n" +
"## Validation Requirements\n" +
validationRequirements.map((v, i) => (i + 1) + ". " + v).join("\n") + "\n\n" +
"## Acceptance Criteria\n" +
acceptanceCriteria.map((a, i) => (i + 1) + ". " + a).join("\n") + "\n";
}

