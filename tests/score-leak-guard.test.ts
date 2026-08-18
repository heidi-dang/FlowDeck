import { describe, it, expect } from "bun:test"
import {
  assertNoScoreLeak,
  isScoreMetadata,
  stripScoreAnnotations,
  ScoreLeakMessage,
} from "../src/services/score-leak-guard"

function fixture(): ScoreLeakMessage[] {
  return [
    {
      info: { role: "user", sessionID: "ses_1" },
      parts: [{ type: "text", text: "run the tests", metadata: undefined }],
    },
    {
      info: { role: "assistant", sessionID: "ses_1" },
      parts: [
        // Leak #1: an assistant text part that IS a FlowDeck score annotation line.
        { type: "text", text: "Shell x — FlowDeck 96%", metadata: undefined },
        // Legitimate assistant prose — must be preserved.
        { type: "text", text: "All tests finished with a clean run.", metadata: undefined },
        // Leak #2: a tool part carrying fd.selfAudit score metadata.
        {
          type: "tool",
          tool: "bash",
          callID: "call_1",
          state: { status: "completed", input: {}, output: "ok", title: "bash", metadata: {} },
          metadata: { fd: { selfAudit: { score: 96, actionClass: "tool", sessionID: "ses_1" } } },
        },
      ],
    },
  ]
}

describe("score-leak-guard", () => {
  it("detects the fd.selfAudit metadata shape", () => {
    expect(isScoreMetadata({ fd: { selfAudit: { score: 96 } } })).toBe(true)
    expect(isScoreMetadata({ fd: {} })).toBe(false)
    expect(isScoreMetadata({})).toBe(false)
    expect(isScoreMetadata(null)).toBe(false)
    expect(isScoreMetadata("FlowDeck 96%")).toBe(false)
    expect(isScoreMetadata({ fd: { selfAudit: "nope" } })).toBe(false)
  })

  it("assertNoScoreLeak is false on the leaking fixture", () => {
    expect(assertNoScoreLeak(fixture())).toBe(false)
  })

  it("strip removes score lines and score metadata; assertNoScoreLeak becomes true", () => {
    const stripped = stripScoreAnnotations(fixture())
    expect(assertNoScoreLeak(stripped)).toBe(true)
  })

  it("strip keeps legitimate text and does not increase the message count", () => {
    const stripped = stripScoreAnnotations(fixture())
    expect(stripped).toHaveLength(fixture().length)
    const assistant = stripped[1]
    const texts = assistant.parts.filter((p: any) => p && p.type === "text" && typeof p.text === "string").map((p: any) => p.text)
    expect(texts).toContain("All tests finished with a clean run.")
    expect(texts).not.toContain("Shell x — FlowDeck 96%")
  })

  it("strip does not mutate the input fixture", () => {
    const input = fixture()
    const before = JSON.stringify(input)
    stripScoreAnnotations(input)
    expect(JSON.stringify(input)).toBe(before)
    // The text leak part and the score metadata are preserved on the original.
    const origAssistant = input[1].parts as any[]
    expect(origAssistant.some((p: any) => typeof p.text === "string" && /FlowDeck \d+%/.test(p.text))).toBe(true)
    expect(origAssistant.some((p: any) => p.metadata && isScoreMetadata(p.metadata))).toBe(true)
  })

  it("strip is idempotent: strip(strip(x)) deep-equals strip(x)", () => {
    const once = stripScoreAnnotations(fixture())
    const twice = stripScoreAnnotations(once)
    expect(twice).toEqual(once)
    // Second pass also reports no leak.
    expect(assertNoScoreLeak(twice)).toBe(true)
  })

  it("returns a NEW array/parts (does not alias the input)", () => {
    const input = fixture()
    const stripped = stripScoreAnnotations(input)
    expect(stripped).not.toBe(input)
    expect(stripped[0]).not.toBe(input[0])
  })
})
