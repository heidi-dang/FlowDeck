/**
 * Task Invocation Adapter
 *
 * OpenCode's built-in `task` tool sends the delegation target as
 * `args.subagent_type`. FlowDeck's previous code read `args.agent`,
 * which is always undefined for real OpenCode Task calls.
 *
 * This adapter normalizes both forms so every downstream guard sees a
 * consistent `NormalizedTaskInvocation` regardless of which field the
 * runtime populated.
 *
 * Field priority:
 *   targetAgent  = args.subagent_type ?? args.agent ?? ""
 *   callerAgent  = hookInput.agent ?? "orchestrator"
 */

export interface NormalizedTaskInvocation {
  sessionID: string
  callID: string
  /** Agent making the delegation call (from hook context, not args) */
  callerAgent: string
  /** Resolved delegation target — reads subagent_type first, then agent */
  targetAgent: string
  /** Which args field the target was resolved from, for audit logging */
  resolvedFrom: "subagent_type" | "agent" | "none"
  prompt: string | undefined
  description: string | undefined
}

function stringValue(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined
}

/**
 * Normalize a `tool.execute.before` hook payload for the `task` tool.
 *
 * @param hookInput - The raw hook input (sessionID, callID, agent on the calling session).
 * @param args      - The args object from the task tool call.
 */
export function normalizeTaskInvocation(
  hookInput: {
    sessionID?: unknown
    callID?: unknown
    agent?: unknown
  },
  args: Record<string, unknown>,
): NormalizedTaskInvocation {
  const sessionID = stringValue(hookInput.sessionID) ?? ""
  const callID = stringValue(hookInput.callID) ?? ""
  const callerAgent = stringValue(hookInput.agent) ?? "orchestrator"

  // Primary field: subagent_type (real OpenCode task schema)
  // Fallback: agent (legacy / test payloads)
  const fromSubagentType = stringValue(args.subagent_type)
  const fromAgent = stringValue(args.agent)

  let targetAgent: string
  let resolvedFrom: NormalizedTaskInvocation["resolvedFrom"]

  if (fromSubagentType !== undefined) {
    targetAgent = fromSubagentType
    resolvedFrom = "subagent_type"
  } else if (fromAgent !== undefined) {
    targetAgent = fromAgent
    resolvedFrom = "agent"
  } else {
    targetAgent = ""
    resolvedFrom = "none"
  }

  return {
    sessionID,
    callID,
    callerAgent,
    targetAgent,
    resolvedFrom,
    prompt: stringValue(args.prompt),
    description: stringValue(args.description),
  }
}
