import { Message, Part } from "@opencode-ai/sdk"

export type HistorySafetyIssue =
  | "EMPTY_ASSISTANT"
  | "REASONING_ONLY_ASSISTANT"
  | "UNRESOLVED_TOOL_CALL"
  | "DUPLICATE_TOOL_CALL_ID"
  | "EMPTY_REPLAY_CONTENT"
  | "REASONING_PART_IN_REPLAY"
  | "ERROR_MESSAGE_IN_REPLAY"

export interface ProviderHistoryDiagnostics {
  safe: boolean
  issues: HistorySafetyIssue[]
  reasoningOnlyTurns: number
  emptyTurns: number
}

/**
 * Neutral recovery marker used to replace provider-incompatible assistant turns.
 * This is a fixed constant — it never contains hidden reasoning content.
 */
export const REPLAY_PLACEHOLDER = "[Previous assistant turn completed without visible output.]"

export function validateHistorySafety(messages: { info: Message; parts: Part[] }[]): ProviderHistoryDiagnostics {
  const diagnostics: ProviderHistoryDiagnostics = {
    safe: true,
    issues: [],
    reasoningOnlyTurns: 0,
    emptyTurns: 0,
  }

  const seenCallIds = new Set<string>()

  for (const msg of messages) {
    if (!msg || !msg.info) continue
    if (msg.parts.length === 0) {
       diagnostics.issues.push("EMPTY_REPLAY_CONTENT")
       diagnostics.safe = false
    }

    if ((msg.info as any).error) {
      if (!diagnostics.issues.includes("ERROR_MESSAGE_IN_REPLAY")) {
        diagnostics.issues.push("ERROR_MESSAGE_IN_REPLAY")
        diagnostics.safe = false
      }
    }

    if (msg.info.role === "assistant") {
      let hasVisibleText = false
      let hasReasoning = false
      let hasToolCall = false

      for (const part of msg.parts) {
        if (part.type === "text" && part.text?.trim()) hasVisibleText = true
        if (part.type === "reasoning") {
          hasReasoning = true
          // Reasoning parts are output-only for reasoning-capable providers
          // (e.g. Gemini) and are rejected when replayed in input history.
          if (!diagnostics.issues.includes("REASONING_PART_IN_REPLAY")) {
            diagnostics.issues.push("REASONING_PART_IN_REPLAY")
            diagnostics.safe = false
          }
        }
        if (part.type === "tool") {
          hasToolCall = true
          const callID = (part as any).callID
          if (callID) {
            if (seenCallIds.has(callID)) {
              diagnostics.issues.push("DUPLICATE_TOOL_CALL_ID")
              diagnostics.safe = false
            } else {
              seenCallIds.add(callID)
            }
          }
          const state = (part as any).state?.status ?? (part as any).state
          if (state === "pending" || state === "running") {
            diagnostics.issues.push("UNRESOLVED_TOOL_CALL")
            diagnostics.safe = false
          }
        }
      }

      if (!hasVisibleText && !hasToolCall && hasReasoning) {
        if (!diagnostics.issues.includes("REASONING_ONLY_ASSISTANT")) diagnostics.issues.push("REASONING_ONLY_ASSISTANT")
        diagnostics.reasoningOnlyTurns++
        diagnostics.safe = false
      } else if (!hasVisibleText && !hasToolCall && !hasReasoning) {
        if (!diagnostics.issues.includes("EMPTY_ASSISTANT")) diagnostics.issues.push("EMPTY_ASSISTANT")
        diagnostics.emptyTurns++
        diagnostics.safe = false
      }
    }
  }

  return diagnostics
}

/**
 * Transform model-visible replay history into a provider-safe shape.
 *
 * The replayed history is the `output.messages` copy handed to the provider by
 * the `experimental.chat.messages.transform` hook. It is NOT the persisted
 * user-facing transcript — assistant reasoning content is stripped from the
 * replayable model history only, and reasoning text is never copied into
 * visible placeholders.
 *
 * Invariants after sanitation (enforced here by construction and asserted by
 * `assertProviderReplayShape` / validateHistorySafety):
 *   - no `reasoning` part survives in any replayed assistant message
 *   - no assistant turn replays with empty content (no visible text, no tool)
 *   - no message with zero parts is replayed
 *   - no message carrying a provider error is replayed
 *   - no unresolved (pending/running) tool call is replayed
 *   - no duplicate tool-call identity is replayed
 */
export function sanitizeReasoningOnlyHistory(messages: { info: Message; parts: Part[] }[]): { info: Message; parts: Part[] }[] {
  return sanitizeReplayHistory(messages)
}

export function sanitizeReplayHistory(messages: { info: Message; parts: Part[] }[]): { info: Message; parts: Part[] }[] {
  const seenCallIds = new Set<string>()
  const out: { info: Message; parts: Part[] }[] = []
  for (const msg of messages) {
    const replay = sanitizeReplayMessage(msg, seenCallIds)
    if (replay) out.push(replay)
  }
  return mergeAdjacentUserTurns(out)
}

/**
 * B-Isolation: merge consecutive user turns that become adjacent after a
 * malformed assistant turn is dropped. Keeps user/assistant alternation valid
 * for every provider without EVER synthesizing visible assistant text.
 */
function mergeAdjacentUserTurns(messages: { info: Message; parts: Part[] }[]): { info: Message; parts: Part[] }[] {
  const result: { info: Message; parts: Part[] }[] = []
  for (const msg of messages) {
    const last = result[result.length - 1]
    if (
      last &&
      msg.info.role === "user" &&
      last.info.role === "user"
    ) {
      const mergedText =
        last.parts
          .filter(p => p.type === "text" && p.text?.trim())
          .map(p => (p as { text?: string }).text ?? "")
          .join("\n") +
        "\n" +
        msg.parts
          .filter(p => p.type === "text" && p.text?.trim())
          .map(p => (p as { text?: string }).text ?? "")
          .join("\n")
      last.parts = [{ type: "text", text: mergedText} as Part]
      continue
    }
    result.push(msg)
  }
  return result
}

function sanitizeReplayMessage(
  msg: { info: Message; parts: Part[] },
  seenCallIds: Set<string>,
): { info: Message; parts: Part[] } | null {
  if (!msg || !msg.info) return null

  // User/system turns: drop if there is nothing to replay, or the turn itself
  // carried a provider error (failed turns must not be replayed).
  if (msg.info.role !== "assistant") {
    if (msg.parts.length === 0) return null
    if ((msg.info as any).error) return null
    return msg
  }

  // A failed assistant message is not a valid replay turn (its request errored
  // out; the provider rejects error-bearing history entries).
  if ((msg.info as any).error) return null

  // Nothing at all to replay.
  if (msg.parts.length === 0) return null

  // B-Isolation: reasoning parts are incompatible with input-history replay for
  // reasoning-capable providers (Gemini rejects reasoningContent in input).
  // They are removed from the EPHEMERAL replayable model history only. The
  // canonical persisted transcript keeps reasoning untouched.
  const partsNoReasoning = msg.parts.filter(part => part.type !== "reasoning")

  let hasVisibleText = false
  let hasCompletedTool = false
  const cleaned: Part[] = []

  for (const part of partsNoReasoning) {
    if (part.type === "text") {
      if (part.text?.trim()) {
        hasVisibleText = true
        cleaned.push(part)
      }
      // Empty text parts are dropped: empty content blocks can be rejected.
    } else if (part.type === "tool") {
      const p = part as any
      const state = typeof p.state === "string" ? p.state : p.state?.status
      if (state === "completed" || !state) {
        hasCompletedTool = true
      }
      if (state === "pending" || state === "running") {
        // B-Isolation: structurally REMOVE unresolved tool calls from the
        // ephemeral replay view instead of synthesizing fake user-visible
        // assistant content. Never generate the placeholder marker.
        continue
      }
      const callID = p.callID
      if (callID) {
        if (seenCallIds.has(callID)) continue // duplicate tool identity: keep first only
        seenCallIds.add(callID)
      }
      cleaned.push(part)
    } else {
      // Control/non-content parts (step-start, step-finish, snapshot, file, ...)
      // are skipped by provider normalization and replay harmlessly. Keep them.
      cleaned.push(part)
    }
  }

  // B-Isolation: a turn with no visible text and no completed tool call cannot
  // be replayed as meaningful content. DROP the malformed assistant turn —
  // never synthesize visible text, never emit the placeholder marker. The
  // caller merges any adjacent user turns.
  if (!hasVisibleText && !hasCompletedTool) {
    return null
  }

  // Normal assistant turn: text and/or completed tool calls. Provider-safe.
  return { info: msg.info, parts: cleaned }
}

/**
 * Assert the actual replayable history shape handed to the provider after
 * FlowDeck sanitation. This is the closest safe FlowDeck boundary to the
 * provider request; it must report safe:true once sanitation has run.
 */
export function assertProviderReplayShape(messages: { info: Message; parts: Part[] }[]): ProviderHistoryDiagnostics {
  return validateHistorySafety(messages)
}

export interface MalformedCompletionDiagnostics {
  sessionID: string
  messageID?: string
  provider?: string
  model?: string
  finishReason?: string
  reasoningTokenCount: number
  textPartCount: number
  toolPartCount: number
  previousSuccessfulTool?: string
}

export function detectNoVisibleOutputCompletion(
  msg: { info: Message; parts: Part[] },
  opts?: {
    /**
     * When true, the caller has confirmed the turn is terminal from external context
     * (e.g. session.idle event). In this case a missing finishReason is still treated
     * as a terminal stop — but ONLY when the caller has positive terminal evidence.
     */
    confirmedTerminal?: boolean
  }
): {
  isMalformed: boolean
  diagnostics?: MalformedCompletionDiagnostics
} {
  if (msg.info.role !== "assistant") {
    return { isMalformed: false }
  }

  if ((msg.info as any).error) {
    return { isMalformed: false }
  }

  let textPartCount = 0
  let toolPartCount = 0
  let reasoningTokenCount = 0
  let finishReason: string | undefined =
    (msg.info as any).finish ?? (msg.info as any).finishReason ?? (msg.info as any).finish_reason

  for (const part of msg.parts) {
    if (part.type === "text" && part.text?.trim()) textPartCount++
    if (part.type === "tool" || (part as any).type === "tool-call") {
      // Any tool call part (completed, running, pending, or errored) is real tool activity
      // and means this assistant turn is a tool-execution turn, NOT an empty/reasoning-only completion.
      toolPartCount++
    }
    if (part.type === "reasoning") reasoningTokenCount += part.text?.length ?? 1
    if (part.type === "step-finish" && (part as any).reason) finishReason = (part as any).reason
  }

  // If tool parts exist or finish indicates tool activity, it is NEVER an empty/reasoning completion
  if (toolPartCount > 0 || finishReason === "tool-calls" || finishReason === "tool_calls") {
    return { isMalformed: false }
  }

  // P0 FIX: A missing finishReason is INSUFFICIENT EVIDENCE of terminal state.
  // Do NOT default to "stop" — the turn may still be in progress (transient
  // message.updated snapshot with no finish signal yet). Absent explicit
  // terminal evidence we must NOT classify the turn as a malformed completion.
  if (!finishReason) {
    if (!opts?.confirmedTerminal || msg.parts.length === 0) {
      return { isMalformed: false }
    }
    // Caller confirmed terminal from session.idle on populated message — treat as stop
    finishReason = "stop"
  }

  const isEmptyNoOutput = textPartCount === 0 && toolPartCount === 0;
  const isStopOrLength = finishReason === "stop" || finishReason === "length" || finishReason === "max_tokens";
  const isMalformed = isEmptyNoOutput && isStopOrLength;

  if (isMalformed) {
    return {
      isMalformed: true,
      diagnostics: {
        sessionID: msg.info.sessionID,
        messageID: msg.info.id,
        reasoningTokenCount,
        textPartCount,
        toolPartCount,
        finishReason,
        provider: (msg.info as any).providerID ?? (msg.info as any).provider,
        model: (msg.info as any).modelID ?? (msg.info as any).model,
      }
    }
  }

  return { isMalformed: false }
}