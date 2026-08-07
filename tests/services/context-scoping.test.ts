import { describe, it, expect } from "bun:test"
import {
  buildAssignmentContext,
  externalizeToolOutput,
  shouldCompact,
  estimateReplayTokens,
} from "../../src/services/context-scoping"
import { MAX_CONTEXT_PACKET_TOKENS } from "../../src/services/token-optimizer-service"

describe("buildAssignmentContext", () => {
  it("produces a bounded prompt under the context packet budget", () => {
    const result = buildAssignmentContext({
      target: "src/services/token-budget.ts",
      blastRadius: "config + hooks",
      patterns: ["camelCase", "kebab-case files"],
      stage: "execute",
      assignment: "Refactor buildTokenBudget to accept overrides.",
    })
    expect(result.parentConversationExcluded).toBe(true)
    expect(result.estimatedTokens).toBeLessThanOrEqual(MAX_CONTEXT_PACKET_TOKENS + 50)
    expect(result.prompt).toContain("## Assignment")
    expect(result.prompt).toContain("## Orchestrator Context")
  })

  it("does not replay parent conversation", () => {
    const result = buildAssignmentContext({
      target: "x",
      stage: "execute",
      assignment: "do the thing",
    })
    // No conversation replay markers.
    expect(result.prompt).not.toContain("user:")
    expect(result.prompt).not.toContain("assistant:")
  })
})

describe("externalizeToolOutput", () => {
  it("returns text unchanged when under budget", () => {
    const r = externalizeToolOutput("short", 100)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe("short")
    expect(r.originalChars).toBe(5)
  })

  it("truncates oversized output with explicit marker", () => {
    const r = externalizeToolOutput("x".repeat(1000), 100)
    expect(r.truncated).toBe(true)
    expect(r.originalChars).toBe(1000)
    expect(r.text.length).toBeLessThanOrEqual(100)
    expect(r.text.endsWith("...")).toBe(true)
  })

  it("handles empty text", () => {
    const r = externalizeToolOutput("", 10)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe("")
  })
})

describe("shouldCompact", () => {
  it("triggers only above threshold", () => {
    expect(shouldCompact(119_000, 120_000)).toBe(false)
    expect(shouldCompact(120_001, 120_000)).toBe(true)
    expect(shouldCompact(120_000, 120_000)).toBe(false)
  })
})

describe("estimateReplayTokens", () => {
  it("estimates tokens from serialized messages", () => {
    const messages = [{ role: "user", content: "hello world hello world" }]
    const tokens = estimateReplayTokens(messages)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(50)
  })

  it("handles un-serializable messages without throwing", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => estimateReplayTokens([circular])).not.toThrow()
    expect(estimateReplayTokens([circular])).toBe(0)
  })
})