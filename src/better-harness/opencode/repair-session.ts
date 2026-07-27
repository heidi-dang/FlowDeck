import type { HarnessFinding } from "../contracts/report";
import { buildRepairPrompt } from "./repair-prompt";
import { saveRepairSession } from "../persistence/repair-session-store";

export interface RepairSessionRequest {
  finding: HarnessFinding;
  projectPath: string;
}

export interface RepairSessionResponse {
  repairSessionId: string;
  prompt: string;
  error?: string;
}

export async function createRepairSession(
  request: RepairSessionRequest,
  opencodeClient?: unknown,
): Promise<RepairSessionResponse> {
  const { finding, projectPath } = request;

  const prompt = buildRepairPrompt({
    finding,
    projectPath,
  });

  // Try OpenCode client if available to create a real session
  if (opencodeClient && typeof opencodeClient === "object") {
    const client = opencodeClient as Record<string, unknown>;
    const sessionNs = client.session as Record<string, unknown> | undefined;
    if (sessionNs && typeof sessionNs.create === "function") {
      try {
        const result = await (sessionNs.create as (opts: Record<string, unknown>) => unknown)({
          body: { title: `Repair: ${finding.title}` },
          query: { directory: projectPath },
        });
        if (result && typeof result === "object") {
          const session = (result as Record<string, unknown>).data as Record<string, unknown> | undefined;
          const sessionId = session?.id as string | undefined;
          if (sessionId) {
            const repairSessionId = "rs_" + sessionId;
            // Persist the session
            saveRepairSession(projectPath, {
              repairSessionId,
              findingId: finding.id,
              prompt,
              status: "created",
              createdAt: new Date().toISOString(),
            });
            return { repairSessionId, prompt };
          }
        }
      } catch {
        return { repairSessionId: "", prompt, error: "Failed to create OpenCode session" };
      }
    }
  }

  // No OpenCode client available, return failure (no synthetic fallback)
  return { repairSessionId: "", prompt, error: "No OpenCode client available for session creation" };
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

