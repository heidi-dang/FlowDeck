import { describe, it, expect } from "bun:test"
import { sanitizeReasoningOnlyHistory, validateHistorySafety } from "../src/services/provider-history-safety"
import type { Message, Part } from "@opencode-ai/sdk"

// Realistic poisoned history: user turn, reasoning-only assistant terminal,
// unresolved tool-call turn, health assistant tool turn, then user continue.
function poisonedHistory() {
  return [
    { info: { id: "u1", role: "user", sessionID: "x" } as Message, parts: [{ type: "text", text: "Implement Phase 9" }] as Part[] },
    {
      info: { id: "a1", role: "assistant", sessionID: "x" } as Message,
      parts: [
        { type: "step-start" } as Part,
        { type: "reasoning", text: "SHAPE-ONLY" } as Part,
        { type: "step-finish", reason: "stop" } as Part,
      ],
    },
    {
      info: { id: "a2", role: "assistant", sessionID: "x" } as Message,
      parts: [{ type: "tool", tool: "bash", callID: "t-pending", state: { status: "pending" } }] as any[],
    },
    {
      info: { id: "a3", role: "assistant", sessionID: "x" } as Message,
      parts: [{ type: "tool", tool: "bash", callID: "t-ok", state: { status: "completed" } }] as any[],
    },
    { info: { id: "u2", role: "user", sessionID: "x" } as Message, parts: [{ type: "text", text: "Continue" }] as Part[] },
  ]
}

describe("REPLAY ISOLATION & IDEMPOTENCY (Requirement B)", () => {
  it("sanitize(sanitize(history)) === sanitize(history) — idempotent and never grows messages", () => {
    const h = poisonedHistory()
    const once = sanitizeReasoningOnlyHistory(h)
    const twice = sanitizeReasoningOnlyHistory(once)
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice))
    // message count never grows
    expect(once.length).toBeLessThanOrEqual(h.length)
    expect(twice.length).toBeLessThanOrEqual(once.length)
  })

  it("placeholder marker count is 0 in the provider replay view; reasoning never leaks", () => {
    const h = poisonedHistory()
    const sanitized = sanitizeReasoningOnlyHistory(h)
    const json = JSON.stringify(sanitized)
    expect(json.split("without visible output").length - 1).toBe(0)
    expect(json).not.toContain("SHAPE-ONLY")
    expect(json).not.toContain("reasoning")
    // no pending/unresolved tool call survives
    expect(json).not.toContain("t-pending")
    // completed tool call survives
    expect(json).toContain("t-ok")
    // final history is provider-safe
    expect(validateHistorySafety(sanitized).safe).toBe(true)
  })

  it("persisted/UI representation is never the provider replay view (structural separation)", () => {
    // The canonical array passed in is NOT mutated by sanitization.
    const h = poisonedHistory()
    const original = JSON.stringify(h)
    sanitizeReasoningOnlyHistory(h)
    expect(JSON.stringify(h)).toBe(original)
    // The sanitizer returns a NEW array — the shared input is untouched.
  })
})
