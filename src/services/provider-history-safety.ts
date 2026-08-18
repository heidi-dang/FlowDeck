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
  return out
}

function sanitizeReplayMessage(
  msg: { info: Message; parts: Part[] },
  seenCallIds: Set<string>,
): { info: Message; parts: Part[] } | null {
  if (!msg || !msg.info) return null

  if (msg.info.role !== "assistant") {
    // User/system turns: drop if there is nothing to replay, or the turn itself
    // carried a provider error (failed turns must not be replayed).
    if (msg.parts.length === 0) return null
    if ((msg.info as any).error) return null
    return msg
  }

  // A failed assistant message is not a valid replay turn (its request errored
  // out; the provider rejects error-bearing history entries).
  if ((msg.info as any).error) return null

  // Nothing at all to replay.
  if (msg.parts.length === 0) return null

  // 1. Reasoning parts are incompatible with input-history replay for
  //    reasoning-capable providers (Gemini rejects reasoningContent in input).
  //    They are removed from the replayable model history. Reasoning text is
  //    NEVER copied into visible placeholder content.
  const partsNoReasoning = msg.parts.filter(part => part.type !== "reasoning")

  let hasVisibleText = false
  let hasToolCall = false
  let hasPendingTool = false
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
        hasToolCall = true
      }
      if (state === "pending" || state === "running") hasPendingTool = true
      if (p.callID) {
        if (seenCallIds.has(p.callID)) continue // duplicate tool identity: keep first only
        seenCallIds.add(p.callID)
      }
      cleaned.push(part)
    } else {
      // Control/non-content parts (step-start, step-finish, snapshot, file, ...)
      // are skipped by provider normalization and replay harmlessly. Keep them.
      cleaned.push(part)
    }
  }

  // 2. A turn whose only content is an unresolved tool call cannot be replayed
  //    as tool state. Replace it with a neutral recovery marker.
  if (hasPendingTool) {
    return { info: msg.info, parts: [{ type: "text", text: REPLAY_PLACEHOLDER } as Part] }
  }

  // 3. A reasoning-only or fully empty assistant turn (no visible text, no tool
  //    call) must not replay as an empty/reasoning-only assistant message.
  if (!hasVisibleText && !hasToolCall) {
    return { info: msg.info, parts: [{ type: "text", text: REPLAY_PLACEHOLDER } as Part] }
  }

  // 4. Normal assistant turn: text and/or completed tool calls. Provider-safe.
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

export function detectNoVisibleOutputCompletion(msg: { info: Message; parts: Part[] }): {
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
  let finishReason = (msg.info as any).finishReason ?? (msg.info as any).finish_reason

  for (const part of msg.parts) {
    if (part.type === "text" && part.text?.trim()) textPartCount++
    if (part.type === "tool") {
      const state = typeof (part as any).state === "string" ? (part as any).state : (part as any).state?.status
      if (state === "completed" || !state) {
        toolPartCount++
      }
    }
    if (part.type === "reasoning") reasoningTokenCount += part.text?.length ?? 1
    if (part.type === "step-finish" && (part as any).reason) finishReason = (part as any).reason
  }

  if (!finishReason) {
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
