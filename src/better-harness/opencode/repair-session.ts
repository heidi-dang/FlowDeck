import type { HarnessFinding } from "../contracts/report";
import { buildRepairPrompt } from "./repair-prompt";
import { saveRepairSession } from "../persistence/repair-session-store";

export interface RepairSessionRequest {
  finding: HarnessFinding;
  projectPath: string;
}

export interface RepairSessionResponse {
  /** Public-facing repair operation identifier (opaque, stable). */
  repairOperationId: string;
  /** The actual OpenCode session ID returned by the runtime. */
  opencodeSessionId: string;
  /** The generated repair prompt content. */
  prompt: string;
  /** Human-readable error when the operation fails. */
  error?: string;
}

/**
 * Create a repair session and submit the generated prompt to OpenCode.
 *
 * The flow depends on the installed OpenCode client API:
 *
 *   A. If `session.create` accepts and delivers an initial prompt message
 *      (verified via the `body.parts` field or a documented delivery
 *      contract), the prompt is submitted once during creation.
 *
 *   B. Otherwise (the installed OpenCode v1.18 SDK), `session.create`
 *      only sets session metadata (title).  The prompt must be submitted
 *      through a separate `session.prompt()` call after creation.
 *
 * This implementation uses flow B, which is the contract confirmed by
 * the installed OpenCode SDK types (SessionCreateData has no message/
 * parts field; SessionPromptData has a `parts` array).
 *
 * The prompt is submitted EXACTLY ONCE via session.prompt().  If create
 * succeeds but prompt delivery fails, the failure is persisted and
 * accepted: false is returned.
 */
export async function createRepairSession(
  request: RepairSessionRequest,
  opencodeClient?: unknown,
): Promise<RepairSessionResponse> {
  const { finding, projectPath } = request;

  const prompt = buildRepairPrompt({
    finding,
    projectPath,
  });

  if (!opencodeClient || typeof opencodeClient !== "object") {
    return {
      repairOperationId: "",
      opencodeSessionId: "",
      prompt,
      error: "No OpenCode client available for session creation",
    };
  }

  const client = opencodeClient as Record<string, unknown>;
  const sessionNs = client.session as
    | { create?: Function; prompt?: Function }
    | undefined;

  if (!sessionNs?.create) {
    return {
      repairOperationId: "",
      opencodeSessionId: "",
      prompt,
      error: "OpenCode client has no session.create method",
    };
  }

  try {
    // 1. Create the session (metadata only — title + project directory)
    const createResult = await sessionNs.create({
      body: { title: `Repair: ${finding.title}` },
      query: { directory: projectPath },
    });

    const sessionData =
      createResult && typeof createResult === "object"
        ? (createResult as Record<string, unknown>).data
        : undefined;
    const rawSessionId =
      sessionData && typeof sessionData === "object"
        ? (sessionData as Record<string, unknown>).id
        : undefined;

    if (!rawSessionId || typeof rawSessionId !== "string") {
      return {
        repairOperationId: "",
        opencodeSessionId: "",
        prompt,
        error: "Session creation did not return a valid session ID",
      };
    }

    const opencodeSessionId: string = rawSessionId;

    // 2. Submit the repair prompt EXACTLY ONCE via session.prompt().
    //    The OpenCode v1.18 SDK's SessionPromptData contract requires:
    //      path: { id: string }
    //      body: { parts: Array<TextPartInput | …>, system?: string }
    if (typeof sessionNs.prompt !== "function") {
      return {
        repairOperationId: "",
        opencodeSessionId,
        prompt,
        error: "OpenCode client has no session.prompt method",
      };
    }

    const promptResult: unknown = await sessionNs.prompt({
      path: { id: opencodeSessionId },
      body: {
        parts: [{ type: "text", text: prompt }],
        system: prompt,
      },
    });

    // 3. Verify prompt delivery — the response object must contain a
    //    data field for a successful submission.
    const promptResponse =
      promptResult && typeof promptResult === "object"
        ? (promptResult as Record<string, unknown>)
        : {};
    const promptOk =
      promptResponse.data !== undefined &&
      promptResponse.data !== null;

    if (!promptOk) {
      // Session was created but prompt delivery failed.
      saveRepairSession(projectPath, {
        repairSessionId: opencodeSessionId,
        findingId: finding.id,
        prompt,
        status: "failed",
        createdAt: new Date().toISOString(),
      });
      return {
        repairOperationId: "",
        opencodeSessionId,
        prompt,
        error: "Repair prompt submission failed",
      };
    }

    // 4. Prompt delivered — persist the confirmed state.
    saveRepairSession(projectPath, {
      repairSessionId: opencodeSessionId,
      findingId: finding.id,
      prompt,
      status: "created",
      createdAt: new Date().toISOString(),
    });

    return {
      repairOperationId: opencodeSessionId,
      opencodeSessionId,
      prompt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      repairOperationId: "",
      opencodeSessionId: "",
      prompt,
      error: `Failed to create or submit repair session: ${msg}`,
    };
  }
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
