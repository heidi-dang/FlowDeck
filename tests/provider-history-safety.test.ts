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
  it("flags malformed completion when visible text and tools are 0 but reasoning > 0 (with explicit step-finish)", () => {
    const msg = {
      info: { id: "2", role: "assistant", sessionID: "s1" } as Message,
      // P0 FIX: A reasoning-only completion must have step-finish to be terminal.
      // Without step-finish the turn is still in progress and must NOT be flagged.
      parts: [
        { type: "reasoning", text: "thinking hard" },
        { type: "step-finish", reason: "stop" }
      ] as Part[]
    }

    const res = detectNoVisibleOutputCompletion(msg)
    expect(res.isMalformed).toBe(true)
    expect(res.diagnostics?.reasoningTokenCount).toBeGreaterThan(0)
    expect(res.diagnostics?.textPartCount).toBe(0)
    expect(res.diagnostics?.toolPartCount).toBe(0)
  })

  it("does NOT flag reasoning-only turn without step-finish (in-progress turn)", () => {
    const msg = {
      info: { id: "2b", role: "assistant", sessionID: "s1" } as Message,
      // No step-finish → transient in-progress snapshot → NOT malformed
      parts: [{ type: "reasoning", text: "thinking hard" }] as Part[]
    }

    const res = detectNoVisibleOutputCompletion(msg)
    expect(res.isMalformed).toBe(false)
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

  it("detects EMPTY_ASSISTANT", () => {
    const messages = [
      {
        info: { id: "2", role: "assistant", sessionID: "s1" } as Message,
        parts: [{ type: "text", text: "" }] as Part[]
      }
    ]
    const diag = validateHistorySafety(messages)
    expect(diag.safe).toBe(false)
    expect(diag.issues).toContain("EMPTY_ASSISTANT")
  })

  it("detects EMPTY_REPLAY_CONTENT", () => {
    const messages = [
      {
        info: { id: "2", role: "assistant", sessionID: "s1" } as Message,
        parts: [] as Part[]
      }
    ]
    const diag = validateHistorySafety(messages)
    expect(diag.safe).toBe(false)
    expect(diag.issues).toContain("EMPTY_REPLAY_CONTENT")
    // Also gets EMPTY_ASSISTANT because it has no visible text
    expect(diag.issues).toContain("EMPTY_ASSISTANT")
  })

  it("detects DUPLICATE_TOOL_CALL_ID", () => {
    const messages = [
      {
        info: { id: "2", role: "assistant", sessionID: "s1" } as Message,
        parts: [
          { type: "tool", callID: "dup-123", state: "completed" },
          { type: "tool", callID: "dup-123", state: "completed" }
        ] as any
      }
    ]
    const diag = validateHistorySafety(messages)
    expect(diag.safe).toBe(false)
    expect(diag.issues).toContain("DUPLICATE_TOOL_CALL_ID")
  })

  it("detects UNRESOLVED_TOOL_CALL", () => {
    const messages = [
      {
        info: { id: "2", role: "assistant", sessionID: "s1" } as Message,
        parts: [
          { type: "tool", callID: "t-1", state: "pending" }
        ] as any
      }
    ]
    const diag = validateHistorySafety(messages)
    expect(diag.safe).toBe(false)
    expect(diag.issues).toContain("UNRESOLVED_TOOL_CALL")
  })

describe("live reasoning-only replay fixture (msg_00a992f730001LM7JU6uwPGo0wZ structural equivalent)", () => {
  // Structural equivalent of the live poisoned turn from session
  // ses_ff5790c58ffeKz0WsQhLXKN6PM: finish=stop, reasoning present,
  // visible text = 0, tool calls = 0. Hidden reasoning text is NOT included.
  const liveFixture = {
    info: { id: "msg_00a992f730001LM7JU6uwPGo0wZ", role: "assistant", sessionID: "ses_ff5790c58ffeKz0WsQhLXKN6PM", providerID: "heidi", modelID: "heidi-antigravity" } as Message,
    parts: [
      { type: "step-start" },
      { type: "reasoning", text: "SHAPE-ONLY: reasoning present, 41 tokens equivalence" },
      { type: "step-finish", reason: "stop" },
    ] as Part[]
  }

  it("sanitizes to a single provider-safe placeholder text part (no reasoning part survives)", () => {
    const sanitized = sanitizeReasoningOnlyHistory([liveFixture])
    expect(sanitized).toHaveLength(1)
    const turn = sanitized[0]
    expect(turn.parts.filter(p => p.type === "reasoning")).toHaveLength(0)
    expect(turn.parts.filter(p => p.type === "text" && p.text?.trim())).toHaveLength(1)
    const text = turn.parts.find(p => p.type === "text") as any
    expect(text.text).toBe("[Previous assistant turn completed without visible output.]")
    // Hidden reasoning must NEVER be exposed into visible placeholder content
    expect(text.text).not.toContain("SHAPE-ONLY")
  })

  it("provider-replay serialization after sanitation contains no reasoning content and no empty assistant content", () => {
    const history = [
      { info: { id: "u1", role: "user", sessionID: "ses_x" } as Message, parts: [{ type: "text", text: "Implement Phase 9" }] as Part[] },
      { info: { id: "a1", role: "assistant", sessionID: "ses_x" } as Message, parts: [{ type: "tool", tool: "bash", callID: "t-1", state: { status: "completed" } }] as any[] },
      liveFixture,
      { info: { id: "u2", role: "user", sessionID: "ses_x" } as Message, parts: [{ type: "text", text: "Continue" }] as Part[] },
    ]
    const sanitized = sanitizeReasoningOnlyHistory(history)
    const diag = validateHistorySafety(sanitized)
    expect(diag.safe).toBe(true)
    expect(diag.issues).toEqual([])
    // Downstream content-block representation (mirrors what an OpenAI-compatible
    // provider normalizer would build): no reasoning blocks, no empty content.
    const blocks = sanitized.map(m => ({
      role: m.info.role,
      content: (m.parts.filter(p => p.type === "text" && (p as any).text?.trim()) as any[]).map(p => (p as any).text).join("\n"),
      hasTool: m.parts.some(p => p.type === "tool"),
      hasReasoning: m.parts.some(p => p.type === "reasoning"),
    }))
    expect(blocks.every(b => !b.hasReasoning)).toBe(true)
    blocks.forEach(b => {
      if (b.role === "assistant") {
        expect(b.content.length > 0 || b.hasTool).toBe(true) // no empty assistant replay
      }
    })
  })

  it("drops the failed continuation message (assistant with error, zero parts)", () => {
    const failed = {
      info: { id: "msg_00a9947d2001S0X3Nqg9lIWamO", role: "assistant", sessionID: "ses_x", error: { name: "APIError", message: "[antigravity/gemini-3.6-flash-high] [400] INVALID_ARGUMENT" } } as any,
      parts: [] as Part[]
    }
    const sanitized = sanitizeReasoningOnlyHistory([failed])
    expect(sanitized).toHaveLength(0)
  })
})

describe("sanitizeReplayHistory provider-safe invariants", () => {
  it("strips reasoning parts from normal assistant turns with visible text", () => {
    const messages = [
      { info: { id: "1", role: "assistant", sessionID: "s1" } as Message, parts: [{ type: "reasoning", text: "think" }, { type: "text", text: "Visible answer" }] as Part[] },
    ]
    const sanitized = sanitizeReasoningOnlyHistory(messages)
    expect(sanitized[0].parts.some(p => p.type === "reasoning")).toBe(false)
    expect(sanitized[0].parts.some(p => p.type === "text" && p.text === "Visible answer")).toBe(true)
    expect(validateHistorySafety(sanitized).safe).toBe(true)
  })

  it("replaces unresolved pending tool turns with the neutral placeholder", () => {
    const messages = [
      { info: { id: "2", role: "assistant", sessionID: "s1" } as Message, parts: [{ type: "tool", tool: "bash", callID: "t-9", state: { status: "pending" } }] as any[] },
    ]
    const sanitized = sanitizeReasoningOnlyHistory(messages)
    expect(sanitized[0].parts).toHaveLength(1)
    expect((sanitized[0].parts[0] as any).type).toBe("text")
    expect((sanitized[0].parts[0] as any).text).toBe("[Previous assistant turn completed without visible output.]")
  })

  it("deduplicates duplicate tool-call identity", () => {
    const messages = [
      { info: { id: "3", role: "assistant", sessionID: "s1" } as Message, parts: [{ type: "tool", tool: "bash", callID: "dup-1", state: "completed" }, { type: "tool", tool: "bash", callID: "dup-1", state: "completed" }] as any[] },
    ]
    const sanitized = sanitizeReasoningOnlyHistory(messages as any)
    const toolParts = (sanitized[0]?.parts ?? []).filter(p => p.type === "tool") as any[]
    const ids = toolParts.map(p => p.callID)
    expect(new Set(ids).size).toBe(ids.length)
    expect(validateHistorySafety(sanitized).safe).toBe(true)
  })

  it("drops zero-part messages and messages carrying provider errors", () => {
    const messages = [
      { info: { id: "u0", role: "user", sessionID: "s1" } as Message, parts: [] as Part[] },
      { info: { id: "a0", role: "assistant", sessionID: "s1" } as Message, parts: [] as Part[] },
      { info: { id: "a1", role: "assistant", sessionID: "s1", error: { message: "APIError" } } as any, parts: [{ type: "text", text: "partial" }] as Part[] },
    ]
    const sanitized = sanitizeReasoningOnlyHistory(messages as any)
    expect(sanitized).toHaveLength(0)
  })

  it("keeps normal tool-call assistant turns intact (minus reasoning)", () => {
    const messages = [
      { info: { id: "a2", role: "assistant", sessionID: "s1" } as Message, parts: [{ type: "step-start" }, { type: "reasoning", text: "hmm" }, { type: "tool", tool: "bash", callID: "ok-1", state: { status: "completed" } }, { type: "step-finish", reason: "tool-calls" }] as any[] },
    ]
    const sanitized = sanitizeReasoningOnlyHistory(messages)
    const turn = sanitized[0]
    expect(turn.parts.some(p => p.type === "tool")).toBe(true)
    expect(turn.parts.some(p => p.type === "reasoning")).toBe(false)
    expect(validateHistorySafety(sanitized).safe).toBe(true)
  })
})
