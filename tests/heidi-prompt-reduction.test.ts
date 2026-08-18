import { describe, it, expect } from "bun:test"
import {
  buildHeidiCoordinatorPrompt,
  buildOrchestratorPrompt,
  createHeidiAgent,
  createOrchestratorAgent,
} from "../src/agents/orchestrator"

const BASELINE_TOKENS = 2933

function estimateTokens(text: string): number {
  return Math.round(Buffer.byteLength(text, "utf-8") / 4)
}

describe("Orchestrator Prompt Reduction — Milestone C", () => {
  // Required: >= 60% reduction for FAST_DIRECT permanent prompt
  it("FAST_DIRECT prompt is at least 60% smaller than baseline", () => {
    const prompt = buildHeidiCoordinatorPrompt(undefined, "FAST_DIRECT")
    const tokens = estimateTokens(prompt)
    const reductionPct = ((BASELINE_TOKENS - tokens) / BASELINE_TOKENS) * 100
    expect(reductionPct).toBeGreaterThanOrEqual(60)
  })

  it("FAST_DIRECT prompt is ideally >= 70% smaller than baseline", () => {
    const prompt = buildHeidiCoordinatorPrompt(undefined, "FAST_DIRECT")
    const tokens = estimateTokens(prompt)
    // Target 70%+ but allow 60% minimum
    const reductionPct = ((BASELINE_TOKENS - tokens) / BASELINE_TOKENS) * 100
    expect(reductionPct).toBeGreaterThanOrEqual(70)
  })

  // Specialist directory must be ABSENT from FAST_DIRECT
  it("FAST_DIRECT prompt does not contain the agent directory section", () => {
    const prompt = buildHeidiCoordinatorPrompt(undefined, "FAST_DIRECT")
    expect(prompt).not.toContain("Available Agents")
    expect(prompt).not.toContain("<Delegation>")
  })

  // Route-first identity must remain in FAST_DIRECT
  it("FAST_DIRECT prompt contains route-first classification logic", () => {
    const prompt = buildHeidiCoordinatorPrompt(undefined, "FAST_DIRECT")
    expect(prompt).toContain("FAST_DIRECT")
    expect(prompt).toContain("Route First")
  })

  // Safety invariants always present
  it("FAST_DIRECT prompt contains safety invariants", () => {
    const prompt = buildHeidiCoordinatorPrompt(undefined, "FAST_DIRECT")
    expect(prompt).toContain("Safety")
    expect(prompt).toContain("Verification")
  })

  // SPECIALIST gets agent directory
  it("SPECIALIST prompt contains the agent directory", () => {
    const prompt = buildHeidiCoordinatorPrompt(undefined, "SPECIALIST")
    expect(prompt).toContain("Available Agents")
    expect(prompt).toContain("<Delegation>")
  })

  // STANDARD gets full workflow stages
  it("STANDARD prompt contains lifecycle stage mappings", () => {
    const prompt = buildHeidiCoordinatorPrompt(undefined, "STANDARD")
    expect(prompt).toContain("Stage → Agent Mapping")
    expect(prompt).toContain("fd-task")
    expect(prompt).toContain("fd-review")
    expect(prompt).toContain("fd-execute")
    expect(prompt).toContain("fd-verify")
    expect(prompt).toContain("fd-done")
  })

  // Default (no executionClass) gets full prompt for backwards compat
  it("default prompt (no class) is backwards-compatible with full content", () => {
    const prompt = buildHeidiCoordinatorPrompt()
    expect(prompt).toContain("Available Agents")
    expect(prompt).toContain("Stage → Agent Mapping")
    expect(prompt).toContain("Route First")
  })

  // buildOrchestratorPrompt alias exists
  it("buildOrchestratorPrompt alias works", () => {
    const prompt = buildOrchestratorPrompt(undefined, "FAST_DIRECT")
    expect(typeof prompt).toBe("string")
    expect(prompt.length).toBeGreaterThan(100)
  })

  // createHeidiAgent / createOrchestratorAgent accept executionClass
  it("createHeidiAgent returns an AgentDefinition with a prompt", () => {
    const agent = createHeidiAgent(undefined, undefined, undefined, undefined, "FAST_DIRECT")
    expect(agent.name).toBe("heidi")
    expect(typeof agent.config.prompt).toBe("string")
  })

  it("createOrchestratorAgent returns an AgentDefinition with a prompt", () => {
    const agent = createOrchestratorAgent(undefined, undefined, undefined, undefined, "STANDARD")
    expect(agent.name).toBe("orchestrator")
    expect(typeof agent.config.prompt).toBe("string")
  })
})
