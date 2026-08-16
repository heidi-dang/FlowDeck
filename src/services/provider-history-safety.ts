import { Message, Part } from "@opencode-ai/sdk"

export type HistorySafetyIssue =
  | "EMPTY_ASSISTANT"
  | "REASONING_ONLY_ASSISTANT"
  | "UNRESOLVED_TOOL_CALL"
  | "DUPLICATE_TOOL_CALL_ID"
  | "EMPTY_REPLAY_CONTENT"

export interface ProviderHistoryDiagnostics {
  safe: boolean
  issues: HistorySafetyIssue[]
  reasoningOnlyTurns: number
  emptyTurns: number
}

export function validateHistorySafety(messages: { info: Message; parts: Part[] }[]): ProviderHistoryDiagnostics {
  const diagnostics: ProviderHistoryDiagnostics = {
    safe: true,
    issues: [],
    reasoningOnlyTurns: 0,
    emptyTurns: 0,
  }

  const seenCallIds = new Set<string>()

  for (const msg of messages) {
    if (msg.parts.length === 0) {
       diagnostics.issues.push("EMPTY_REPLAY_CONTENT")
       diagnostics.safe = false
    }

    if (msg.info.role === "assistant") {
      let hasVisibleText = false
      let hasReasoning = false
      let hasToolCall = false

      for (const part of msg.parts) {
        if (part.type === "text" && part.text?.trim()) hasVisibleText = true
        if (part.type === "reasoning") hasReasoning = true
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

export function sanitizeReasoningOnlyHistory(messages: { info: Message; parts: Part[] }[]): { info: Message; parts: Part[] }[] {
  return messages.map(msg => {
    if (msg.info.role !== "assistant") return msg

    let hasVisibleText = false
    let hasReasoning = false
    let hasToolCall = false

    for (const part of msg.parts) {
      if (part.type === "text" && part.text?.trim()) hasVisibleText = true
      if (part.type === "reasoning") hasReasoning = true
      if (part.type === "tool") hasToolCall = true
    }

    if (!hasVisibleText && !hasToolCall && hasReasoning) {
      return {
        info: msg.info,
        parts: [
          ...msg.parts,
          { type: "text", text: "[Previous assistant turn completed without visible output.]" } as Part
        ]
      }
    }

    return msg
  })
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
    if (part.type === "tool") toolPartCount++
    if (part.type === "reasoning") reasoningTokenCount += part.text?.length ?? 1
    if (part.type === "step-finish" && (part as any).reason) finishReason = (part as any).reason
  }

  if (!finishReason) {
    finishReason = "stop"
  }

  const isMalformed = textPartCount === 0 && toolPartCount === 0 && reasoningTokenCount > 0 && finishReason === "stop"

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
