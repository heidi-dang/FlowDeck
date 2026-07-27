/**
 * Runtime Agent Policy Tests
 *
 * Covers:
 * - Config schema resolution
 * - Top-level user message enforcement (strict, warn, off)
 * - Non-top-level and non-user messages skipped
 * - Identity anti-fabrication markers (match, mismatch)
 * - Audit data redaction
 */

import { describe, it, expect } from "vitest"
import type { FlowDeckConfig } from "../src/config/schema"
import {
  resolveRuntimeAgentConfig,
  evaluateRuntimeAgentPolicy,
  buildIdentityMarker,
  appendRuntimeIdentityMarker,
  type RuntimeAgentContext,
  type RuntimeAgentConfig,
} from "../src/services/runtime-agent-policy"

function makeContext(overrides: Partial<RuntimeAgentContext> = {}): RuntimeAgentContext {
  return {
    isTopLevel: true,
    isUserMessage: true,
    agent: "heidi",
    sessionID: "test-session-1",
    packageVersion: "0.8.0-alpha.8",
    ...overrides,
  }
}

describe("resolveRuntimeAgentConfig", () => {
  it("returns strict/heidi by default", () => {
    const cfg = resolveRuntimeAgentConfig({} as FlowDeckConfig)
    expect(cfg.enforcement).toBe("strict")
    expect(cfg.expectedAgent).toBe("heidi")
  })

  it("honors explicit enforcement", () => {
    const cfg = resolveRuntimeAgentConfig({
      runtimeAgent: { enforcement: "warn" },
    } as unknown as FlowDeckConfig)
    expect(cfg.enforcement).toBe("warn")
  })

  it("honors explicit expectedAgent", () => {
    const cfg = resolveRuntimeAgentConfig({
      runtimeAgent: { expectedAgent: "build" },
    } as unknown as FlowDeckConfig)
    expect(cfg.expectedAgent).toBe("build")
  })

  it("accepts off mode", () => {
    const cfg = resolveRuntimeAgentConfig({
      runtimeAgent: { enforcement: "off" },
    } as unknown as FlowDeckConfig)
    expect(cfg.enforcement).toBe("off")
  })
})

describe("evaluateRuntimeAgentPolicy - top-level user messages", () => {
  const baseCfg: RuntimeAgentConfig = { enforcement: "strict", expectedAgent: "heidi" }

  it("passes when expected agent matches actual agent", () => {
    const ctx = makeContext({ agent: "heidi" })
    const result = evaluateRuntimeAgentPolicy(ctx, baseCfg, "/tmp")
    expect(result.allowed).toBe(true)
    expect(result.match).toBe(true)
  })

  it("blocks mismatched agent in strict mode", () => {
    const ctx = makeContext({ agent: "build" })
    const result = evaluateRuntimeAgentPolicy(ctx, baseCfg, "/tmp")
    expect(result.allowed).toBe(false)
    expect(result.match).toBe(false)
    expect(result.reason).toContain("FLOWDECK_AGENT_MISMATCH")
  })

  it("allows mismatched agent with identity marker in warn mode", () => {
    const ctx = makeContext({ agent: "build" })
    const result = evaluateRuntimeAgentPolicy(ctx, { enforcement: "warn", expectedAgent: "heidi" }, "/tmp")
    expect(result.allowed).toBe(true)
    expect(result.match).toBe(false)
    expect(result.identityMarker).toContain("Runtime agent ID: build")
    expect(result.identityMarker).toContain("Do not claim to be Heidi")
  })

  it("allows mismatched agent with identity marker in off mode", () => {
    const ctx = makeContext({ agent: "build" })
    const result = evaluateRuntimeAgentPolicy(ctx, { enforcement: "off", expectedAgent: "heidi" }, "/tmp")
    expect(result.allowed).toBe(true)
    expect(result.match).toBe(false)
    expect(result.identityMarker).toContain("Runtime agent ID: build")
  })

  it("allows build when configured default is build", () => {
    const ctx = makeContext({ agent: "build" })
    const result = evaluateRuntimeAgentPolicy(ctx, { enforcement: "strict", expectedAgent: "build" }, "/tmp")
    expect(result.allowed).toBe(true)
    expect(result.match).toBe(true)
  })

  it("returns identity marker for matching agents", () => {
    const ctx = makeContext({ agent: "heidi" })
    const result = evaluateRuntimeAgentPolicy(ctx, baseCfg, "/tmp")
    expect(result.identityMarker).toContain("FlowDeck Heidi coordinator")
  })
})

describe("evaluateRuntimeAgentPolicy - non-top-level and non-user messages", () => {
  const baseCfg: RuntimeAgentConfig = { enforcement: "strict", expectedAgent: "heidi" }

  it("skips non-top-level sessions (child/subagent)", () => {
    const ctx = makeContext({ isTopLevel: false, agent: "build" })
    const result = evaluateRuntimeAgentPolicy(ctx, baseCfg, "/tmp")
    expect(result.allowed).toBe(true)
    // Still gets identity marker for its actual agent
    expect(result.identityMarker).toContain("Runtime agent ID: build")
  })

  it("skips non-user messages (synthetic/internal)", () => {
    const ctx = makeContext({ isUserMessage: false, agent: "build" })
    const result = evaluateRuntimeAgentPolicy(ctx, baseCfg, "/tmp")
    expect(result.allowed).toBe(true)
  })

  it("still adds identity marker for child session with matching agent", () => {
    const ctx = makeContext({ isTopLevel: false, isUserMessage: true, agent: "heidi" })
    const result = evaluateRuntimeAgentPolicy(ctx, baseCfg, "/tmp")
    expect(result.allowed).toBe(true)
    expect(result.identityMarker).toContain("FlowDeck Heidi coordinator")
  })
})

describe("buildIdentityMarker", () => {
  it("returns Heidi coordinator marker for heidi/heidi", () => {
    const marker = buildIdentityMarker("heidi", "heidi")
    expect(marker).toContain("FlowDeck Heidi coordinator")
    expect(marker).not.toContain("Do not claim")
  })

  it("returns actual-agent marker for build/heidi mismatch", () => {
    const marker = buildIdentityMarker("build", "heidi")
    expect(marker).toContain("Runtime agent ID: build")
    expect(marker).toContain("Do not claim to be Heidi")
  })

  it("returns agent marker for build/build match", () => {
    const marker = buildIdentityMarker("build", "build")
    expect(marker).toContain('OpenCode agent "build"')
    expect(marker).not.toContain("Heidi coordinator")
  })

  it("returns null for empty agent", () => {
    expect(buildIdentityMarker("", "heidi")).toBeNull()
  })
})

describe("appendRuntimeIdentityMarker", () => {
  it("appends marker to existing system content", () => {
    const result = appendRuntimeIdentityMarker("Existing system prompt.", "Runtime agent ID: heidi.\nYou are the FlowDeck Heidi coordinator.")
    expect(result).toContain("Existing system prompt.")
    expect(result).toContain("Runtime agent ID: heidi")
    expect(result).toContain("FlowDeck Heidi coordinator")
  })

  it("does not duplicate marker when already present", () => {
    const existing = "Existing.\n\nRuntime agent ID: heidi.\nYou are the FlowDeck Heidi coordinator."
    const result = appendRuntimeIdentityMarker(existing, "Runtime agent ID: heidi.\nYou are the FlowDeck Heidi coordinator.")
    expect((result.match(/Runtime agent ID:/g) || []).length).toBe(1)
  })

  it("handles null system content", () => {
    const result = appendRuntimeIdentityMarker(null, "Runtime agent ID: heidi.\nYou are the FlowDeck Heidi coordinator.")
    expect(result).toContain("Runtime agent ID: heidi")
  })

  it("returns empty string when no marker provided", () => {
    expect(appendRuntimeIdentityMarker(null, null)).toBe("")
  })
})
