import { Message, Part } from "@opencode-ai/sdk"

export type HistorySafetyIssue =
  | "EMPTY_ASSISTANT"
  | "REASONING_ONLY_ASSISTANT"
  | "ORPHAN_TOOL_RESULT"
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

  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      let hasVisibleText = false
      let hasReasoning = false
      let hasToolCall = false

      for (const part of msg.parts) {
        if (part.type === "text" && part.text?.trim()) hasVisibleText = true
        if (part.type === "reasoning") hasReasoning = true
        if (part.type === "tool") hasToolCall = true
      }

      if (!hasVisibleText && !hasToolCall && hasReasoning) {
        diagnostics.issues.push("REASONING_ONLY_ASSISTANT")
        diagnostics.reasoningOnlyTurns++
        diagnostics.safe = false
      } else if (!hasVisibleText && !hasToolCall && !hasReasoning) {
        diagnostics.issues.push("EMPTY_ASSISTANT")
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

  let textPartCount = 0
  let toolPartCount = 0
  let reasoningTokenCount = 0

  for (const part of msg.parts) {
    if (part.type === "text" && part.text?.trim()) textPartCount++
    if (part.type === "tool") toolPartCount++
    if (part.type === "reasoning") reasoningTokenCount += part.text?.length ?? 1
  }

  const isMalformed = textPartCount === 0 && toolPartCount === 0 && reasoningTokenCount > 0

  if (isMalformed) {
    return {
      isMalformed: true,
      diagnostics: {
        sessionID: msg.info.sessionID,
        messageID: msg.info.id,
        reasoningTokenCount,
        textPartCount,
        toolPartCount,
        finishReason: "stop"
      }
    }
  }

  return { isMalformed: false }
}
