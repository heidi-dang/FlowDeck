/**
 * Runtime Agent Policy Tests
 *
 * Covers:
 * - Config schema: strict, warn, off modes
 * - Match: heidi resolves as heidi
 * - Mismatch: strict blocks build
 * - Mismatch: warn allows but logs
 * - Mismatch: off passes without blocking
 * - User-configured build default allows build
 * - Subagent sessions excluded
 * - Synthetic variants excluded
 * - Identity anti-fabrication marker
 */

import { describe, it, expect } from "vitest"
import type { FlowDeckConfig } from "../src/config/schema"
import {
  enforceRuntimeAgent,
  resolveRuntimeAgentConfig,
  applyIdentityMarker,
} from "../src/services/runtime-agent-policy"

describe("resolveRuntimeAgentConfig", () => {
  it("returns strict/heidi by default", () => {
    const cfg = resolveRuntimeAgentConfig({} as FlowDeckConfig)
    expect(cfg.enforcement).toBe("strict")
    expect(cfg.expectedAgent).toBe("heidi")
  })

  it("honors explicit enforcement", () => {
    const cfg = resolveRuntimeAgentConfig({
      runtimeAgent: { enforcement: "warn" },
    } as FlowDeckConfig)
    expect(cfg.enforcement).toBe("warn")
  })

  it("honors explicit expectedAgent", () => {
    const cfg = resolveRuntimeAgentConfig({
      runtimeAgent: { expectedAgent: "build" },
    } as FlowDeckConfig)
    expect(cfg.expectedAgent).toBe("build")
  })

  it("off mode disables enforcement", () => {
    const cfg = resolveRuntimeAgentConfig({
      runtimeAgent: { enforcement: "off" },
    } as FlowDeckConfig)
    expect(cfg.enforcement).toBe("off")
  })
})

describe("enforceRuntimeAgent", () => {
  const baseInput = {
    sessionID: "test-session-1",
    agent: "heidi",
    variant: undefined as string | undefined,
    expectedAgent: "heidi",
    enforcement: "strict" as const,
    directory: "/tmp",
    packageVersion: "0.8.0-alpha.8",
  }

  it("passes when expected agent matches actual agent (strict)", () => {
    const result = enforceRuntimeAgent(baseInput)
    expect(result.allowed).toBe(true)
    expect(result.match).toBe(true)
  })

  it("blocks mismatched agent in strict mode", () => {
    const result = enforceRuntimeAgent({ ...baseInput, agent: "build" })
    expect(result.allowed).toBe(false)
    expect(result.match).toBe(false)
    expect(result.reason).toContain("FLOWDECK_AGENT_MISMATCH")
  })

  it("allows mismatched agent in warn mode", () => {
    const result = enforceRuntimeAgent({ ...baseInput, agent: "build", enforcement: "warn" })
    expect(result.allowed).toBe(true)
    expect(result.match).toBe(false)
  })

  it("allows mismatched agent in off mode", () => {
    const result = enforceRuntimeAgent({ ...baseInput, agent: "build", enforcement: "off" })
    expect(result.allowed).toBe(true)
    expect(result.match).toBe(false)
  })

  it("allows build when configured default is build", () => {
    const result = enforceRuntimeAgent({ ...baseInput, agent: "build", expectedAgent: "build" })
    expect(result.allowed).toBe(true)
    expect(result.match).toBe(true)
  })

  it("skips subagent sessions", () => {
    const result = enforceRuntimeAgent({ ...baseInput, sessionID: "child-abc-123" })
    expect(result.allowed).toBe(true)
    expect(result.match).toBe(true)
  })

  it("skips synthetic title variants", () => {
    const result = enforceRuntimeAgent({ ...baseInput, variant: "title" })
    expect(result.allowed).toBe(true)
  })

  it("skips synthetic summary variants", () => {
    const result = enforceRuntimeAgent({ ...baseInput, variant: "summary" })
    expect(result.allowed).toBe(true)
  })

  it("skips compaction variants", () => {
    const result = enforceRuntimeAgent({ ...baseInput, variant: "compaction" })
    expect(result.allowed).toBe(true)
  })

  it("skips continuation variants", () => {
    const result = enforceRuntimeAgent({ ...baseInput, variant: "continuation" })
    expect(result.allowed).toBe(true)
  })
})

describe("applyIdentityMarker", () => {
  it("adds identity marker when agent matches expected", () => {
    const result = applyIdentityMarker("Existing system prompt.", "heidi", "heidi")
    expect(result).toContain("Existing system prompt.")
    expect(result).toContain("Runtime agent ID: heidi")
    expect(result).toContain("Do not claim to be Heidi")
  })

  it("returns identity marker for null/undefined system content", () => {
    const result = applyIdentityMarker(null, "heidi", "heidi")
    expect(result).toContain("Runtime agent ID: heidi")
    expect(result).toContain("Do not claim to be Heidi")
  })

  it("does not duplicate marker when already applied", () => {
    const withMarker = "Existing.\n\nRuntime agent ID: heidi.\nYou must describe yourself using this runtime identity."
    const result = applyIdentityMarker(withMarker, "heidi", "heidi")
    // Should only appear once
    expect((result.match(/Runtime agent ID:/g) || []).length).toBe(1)
  })

  it("does not add marker when agent differs and enforcement would not require it", () => {
    // applyIdentityMarker is called regardless — it adds marker when agent == expectedAgent
    const result = applyIdentityMarker("prompt", "build", "heidi")
    expect(result).toBe("prompt")
  })
})
