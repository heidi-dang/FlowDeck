import { describe, it, expect } from "bun:test"
import { HEIDI_CODE_MODE_POLICY, resolveCodeModeCapability } from "../src/services/heidi-code-mode-policy"
import { buildTaskSpecificPromptSections } from "../src/agents/orchestrator"
import { evaluateCodeModeEligibility } from "../src/services/heidi-code-mode-evaluator"

describe("Heidi Code Mode Policy", () => {
  it("rejects when not an MCP composition candidate", () => {
    const res = evaluateCodeModeEligibility("Fix this issue in src/index.ts", false)
    expect(res.isEligible).toBe(false)
    expect(res.rejectionReason).toBe("NOT_MCP_COMPOSITION")
  })

  it("rejects when workflow is too complex or open-ended", () => {
    const phrases = [
      "Continuously investigate all GitHub issues, keep iterating until every issue has a root cause.",
      "Comprehensively search all pages across everything until all results are found.",
      "Exhaustively crawl all repositories and keep exploring.",
      "Paginate through all records indefinitely.",
    ]
    for (const phrase of phrases) {
      const res = evaluateCodeModeEligibility(phrase, true)
      expect(res.isEligible).toBe(false)
      expect(["TOO_COMPLEX", "TOO_MANY_TOOL_CALLS"]).toContain(res.rejectionReason!)
      expect(res.telemetry.codeModeSelected).toBe(false)
    }
  })

  it("rejects when retry is required", () => {
    const res = evaluateCodeModeEligibility("Fetch GitHub issues and use exponential backoff for rate limits.", true)
    expect(res.isEligible).toBe(false)
    expect(res.rejectionReason).toBe("REQUIRES_RETRY")
  })

  it("rejects when specialist spawning is requested", () => {
    const res = evaluateCodeModeEligibility("List GitHub issues and spawn a specialist for each.", true)
    expect(res.isEligible).toBe(false)
    expect(res.rejectionReason).toBe("REQUIRES_TASK")
  })

  it("rejects when shell execution is required", () => {
    const res = evaluateCodeModeEligibility("Get GitHub issues and run bash to grep them.", true)
    expect(res.isEligible).toBe(false)
    expect(res.rejectionReason).toBe("REQUIRES_SHELL")
  })

  it("rejects when file system mutation is required", () => {
    const res = evaluateCodeModeEligibility("Get GitHub issues and write to file.", true)
    expect(res.isEligible).toBe(false)
    expect(res.rejectionReason).toBe("REQUIRES_FILESYSTEM")
  })

  it("rejects when direct network calls are requested", () => {
    const res = evaluateCodeModeEligibility("Get issues and call fetch() directly to send webhook.", true)
    expect(res.isEligible).toBe(false)
    expect(res.rejectionReason).toBe("REQUIRES_DIRECT_NETWORK")
  })

  it("rejects recursion and nested execute", () => {
    const res1 = evaluateCodeModeEligibility("Write a recursive function to fetch comments.", true)
    expect(res1.isEligible).toBe(false)
    expect(res1.rejectionReason).toBe("TOO_COMPLEX")

    const res2 = evaluateCodeModeEligibility("Use nested execute tool call inside script.", true)
    expect(res2.isEligible).toBe(false)
    expect(res2.rejectionReason).toBe("TOO_COMPLEX")
  })

  it("rejects when collection item count is too large", () => {
    const res = evaluateCodeModeEligibility("Fetch top 100 issues from GitHub.", true)
    expect(res.isEligible).toBe(false)
    expect(res.rejectionReason).toBe("COLLECTION_TOO_LARGE")
  })

  it("rejects when too many tool calls are estimated", () => {
    const res = evaluateCodeModeEligibility("List all issues and every pull request and aggregate them.", true)
    expect(res.isEligible).toBe(false)
    expect(res.rejectionReason).toBe("TOO_MANY_TOOL_CALLS")
  })

  it("accepts valid bounded compositions", () => {
    const res = evaluateCodeModeEligibility("List open GitHub issues and PRs, correlate the bug issues with related PRs, and return the matching pairs.", true)
    expect(res.isEligible).toBe(true)
    expect(res.telemetry.codeModeSelected).toBe(true)
    expect(res.telemetry.estimatedToolCalls).toBeLessThanOrEqual(10)
    expect(res.telemetry.estimatedParallelWidth).toBeLessThanOrEqual(4)
    expect(res.telemetry.estimatedDependencyStages).toBeLessThanOrEqual(3)
  })

  it("truthfully resolves capability: UNAVAILABLE when disabled, UNKNOWN when enabled but unproven, AVAILABLE when execute tool present", () => {
    expect(resolveCodeModeCapability({ featureEnabled: false, hasNativeSupport: true })).toBe("UNAVAILABLE")
    expect(resolveCodeModeCapability({ featureEnabled: true, hasNativeSupport: false })).toBe("UNAVAILABLE")
    expect(resolveCodeModeCapability({ featureEnabled: true, hasNativeSupport: true })).toBe("UNKNOWN")
    expect(resolveCodeModeCapability({ featureEnabled: true, hasNativeSupport: true, hasExecuteTool: false })).toBe("UNKNOWN")
    expect(resolveCodeModeCapability({ featureEnabled: true, hasNativeSupport: true, hasExecuteTool: true })).toBe("AVAILABLE")
  })

  it("defines bounded execution limits", () => {
    expect(HEIDI_CODE_MODE_POLICY.maxLines).toBe(80)
    expect(HEIDI_CODE_MODE_POLICY.maxSourceBytes).toBe(12_288)
    expect(HEIDI_CODE_MODE_POLICY.maxToolCalls).toBe(10)
    expect(HEIDI_CODE_MODE_POLICY.maxParallelCalls).toBe(4)
    expect(HEIDI_CODE_MODE_POLICY.maxDependencyStages).toBe(3)
    expect(HEIDI_CODE_MODE_POLICY.maxCollectionItems).toBe(25)
    expect(HEIDI_CODE_MODE_POLICY.timeoutMs).toBe(30_000)
    expect(HEIDI_CODE_MODE_POLICY.maxOutputBytes).toBe(65_536)
  })

  it("disables complex control flow and ambient authority", () => {
    expect(HEIDI_CODE_MODE_POLICY.maxRetries).toBe(0)
    expect(HEIDI_CODE_MODE_POLICY.allowRecursion).toBe(false)
    expect(HEIDI_CODE_MODE_POLICY.allowNestedExecute).toBe(false)
    expect(HEIDI_CODE_MODE_POLICY.allowAgentSpawning).toBe(false)
    expect(HEIDI_CODE_MODE_POLICY.allowImports).toBe(false)
    expect(HEIDI_CODE_MODE_POLICY.allowDynamicCode).toBe(false)
    expect(HEIDI_CODE_MODE_POLICY.allowFilesystem).toBe(false)
    expect(HEIDI_CODE_MODE_POLICY.allowShell).toBe(false)
    expect(HEIDI_CODE_MODE_POLICY.allowDirectNetwork).toBe(false)
    expect(HEIDI_CODE_MODE_POLICY.allowEnvironment).toBe(false)
  })

  it("injects lazy code mode guidance only when available and a composition candidate", () => {
    const withoutCandidate = buildTaskSpecificPromptSections("STANDARD", undefined, undefined, { codeModeCapability: "AVAILABLE", mcpCompositionCandidate: false })
    expect(withoutCandidate).not.toContain("Native Code Mode (OpenCode execute tool)")

    const withoutAvailable = buildTaskSpecificPromptSections("STANDARD", undefined, undefined, { codeModeCapability: "UNAVAILABLE", mcpCompositionCandidate: true })
    expect(withoutAvailable).not.toContain("Native Code Mode (OpenCode execute tool)")

    const withGuidance = buildTaskSpecificPromptSections("STANDARD", undefined, undefined, { codeModeCapability: "AVAILABLE", mcpCompositionCandidate: true })
    expect(withGuidance).toContain("Native Code Mode (OpenCode execute tool)")
    expect(withGuidance).toContain("Max Tool Calls: 10 total")
    expect(withGuidance).toContain("NO RETRIES")
    expect(withGuidance).toContain("NO RECURSION")
  })
})
