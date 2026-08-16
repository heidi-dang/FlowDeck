import { describe, it, expect } from "vitest"
import { validateHistorySafety, sanitizeReasoningOnlyHistory } from "../src/services/provider-history-safety"
import type { Message, Part } from "@opencode-ai/sdk"

describe("Heidi Reasoning Recovery & Replay Safety", () => {
  it("prevents HTTP 400 INVALID_ARGUMENT by converting empty/reasoning-only payload to provider-safe history", () => {
    // 1. Exact reproduction fixture:
    // user: "Implement Phase 8"
    // assistant: tool call bash
    // tool result: npm tests pass
    // assistant: step-start, reasoning(non-empty), step-finish(reason=stop), no text, no tool call
    // user: "Why you stop"
    const messages = [
      {
        info: { id: "msg_1", role: "user", sessionID: "ses_123" } as Message,
        parts: [{ type: "text", text: "Implement Phase 8" }] as Part[]
      },
      {
        info: { id: "msg_2", role: "assistant", sessionID: "ses_123" } as Message,
        parts: [{ type: "tool", tool: "bash", state: { status: "completed" } }] as Part[]
      },
      {
        info: { id: "msg_3", role: "assistant", sessionID: "ses_123" } as Message,
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "Internal thought process..." },
          { type: "step-finish", reason: "stop" }
        ] as Part[]
      },
      {
        info: { id: "msg_4", role: "user", sessionID: "ses_123" } as Message,
        parts: [{ type: "text", text: "Why you stop" }] as Part[]
      }
    ]

    // Validate history before sanitation
    const initialDiag = validateHistorySafety(messages)
    expect(initialDiag.safe).toBe(false)
    expect(initialDiag.issues).toContain("REASONING_ONLY_ASSISTANT")

    // Sanitize for replay
    const sanitized = sanitizeReasoningOnlyHistory(messages)

    // Verify sanitized structure
    const targetTurn = sanitized.find(m => m.info.id === "msg_3")
    expect(targetTurn).toBeDefined()
    
    // Must contain safe visible placeholder
    const textPart = targetTurn?.parts.find(p => p.type === "text")
    expect(textPart).toBeDefined()
    expect((textPart as any)?.text).toBe("[Previous assistant turn completed without visible output.]")

    // Hidden reasoning text must NOT be exposed or duplicated into text part
    expect((textPart as any)?.text).not.toContain("Internal thought process...")

    // Validate history after sanitation -> must be safe
    const finalDiag = validateHistorySafety(sanitized)
    expect(finalDiag.safe).toBe(true)
    expect(finalDiag.issues).toHaveLength(0)
  })
})
