import { describe, it, expect } from "vitest"
import { validateHistorySafety, sanitizeReasoningOnlyHistory } from "../src/services/provider-history-safety"
import type { Message, Part } from "@opencode-ai/sdk"

describe("provider-history-safety", () => {
  it("detects reasoning-only assistant turns", () => {
    const messages = [
      {
        info: { id: "1", role: "user", sessionID: "s1" } as Message,
        parts: [{ type: "text", text: "Hello" }] as Part[]
      },
      {
        info: { id: "2", role: "assistant", sessionID: "s1" } as Message,
        parts: [{ type: "reasoning", text: "thinking..." }] as Part[]
      }
    ]

    const diag = validateHistorySafety(messages)
    expect(diag.safe).toBe(false)
    expect(diag.issues).toContain("REASONING_ONLY_ASSISTANT")
    expect(diag.reasoningOnlyTurns).toBe(1)
  })

  it("sanitizes reasoning-only assistant turns by inserting provider-safe placeholder", () => {
    const messages = [
      {
        info: { id: "1", role: "user", sessionID: "s1" } as Message,
        parts: [{ type: "text", text: "Hello" }] as Part[]
      },
      {
        info: { id: "2", role: "assistant", sessionID: "s1" } as Message,
        parts: [{ type: "reasoning", text: "thinking..." }] as Part[]
      }
    ]

    const sanitized = sanitizeReasoningOnlyHistory(messages)
    expect(sanitized[1].parts.some(p => p.type === "text" && p.text?.includes("without visible output"))).toBe(true)
    
    const diagAfter = validateHistorySafety(sanitized)
    expect(diagAfter.safe).toBe(true)
  })
})

import { detectNoVisibleOutputCompletion } from "../src/services/provider-history-safety"

describe("detectNoVisibleOutputCompletion", () => {
  it("flags malformed completion when visible text and tools are 0 but reasoning > 0", () => {
    const msg = {
      info: { id: "2", role: "assistant", sessionID: "s1" } as Message,
      parts: [{ type: "reasoning", text: "thinking hard" }] as Part[]
    }

    const res = detectNoVisibleOutputCompletion(msg)
    expect(res.isMalformed).toBe(true)
    expect(res.diagnostics?.reasoningTokenCount).toBeGreaterThan(0)
    expect(res.diagnostics?.textPartCount).toBe(0)
    expect(res.diagnostics?.toolPartCount).toBe(0)
  })

  it("does not flag normal assistant turn with visible text", () => {
    const msg = {
      info: { id: "2", role: "assistant", sessionID: "s1" } as Message,
      parts: [
        { type: "reasoning", text: "thinking..." },
        { type: "text", text: "Here is the response." }
      ] as Part[]
    }

    const res = detectNoVisibleOutputCompletion(msg)
    expect(res.isMalformed).toBe(false)
  })
})
