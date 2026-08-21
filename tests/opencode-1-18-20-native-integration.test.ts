import { describe, it, expect } from "bun:test"
import {
  parseOpenCodeVersion,
  classifyOpenCodeCompatibility,
  openCodeCompatibilityCheck,
  backgroundSubagentCapabilityCheck,
  codeModeCapabilityCheck,
} from "../src/doctor/checks/runtime"
import { normalizeTaskInvocation } from "../src/services/task-invocation-adapter"
import {
  buildHeidiCoordinatorPrompt,
  buildTaskSpecificPromptSections,
  estimateCorePromptTokens,
} from "../src/agents/orchestrator"
import {
  HeidiActiveCoordinator,
  registerParallelCoordinator,
  clearParallelCoordinator,
} from "../src/services/heidi-active-coordinator"
import { renderParallelPacket } from "../src/services/heidi-parallel-context"

describe("OpenCode v1.18.20 Native Integration Suite", () => {
  describe("Phase 1 & 2: Version Qualification & Doctor Capability Matrix", () => {
    it("classifies v1.18.20 as FULLY_QUALIFIED and RECOMMENDED target", () => {
      const parsed = parseOpenCodeVersion("1.18.20")
      expect(parsed).toEqual({ major: 1, minor: 18, patch: 20 })

      const compat = classifyOpenCodeCompatibility("1.18.20")
      expect(compat.qualification).toBe("FULLY_QUALIFIED")
      expect(compat.status).toBe("FULLY_QUALIFIED")
      expect(compat.details).toContain("Authoritative Qualification Target")

      const check = openCodeCompatibilityCheck("1.18.20")
      expect(check.status).toBe("pass")
      expect(check.evidence?.qualification).toBe("FULLY_QUALIFIED")
      expect(check.evidence?.recommended).toBe("1.18.20")
    })

    it("maintains backward compatibility with >= 1.18.18 as SUPPORTED baseline", () => {
      const compat18 = classifyOpenCodeCompatibility("1.18.18")
      expect(compat18.qualification).toBe("SUPPORTED")

      const compat19 = classifyOpenCodeCompatibility("1.18.19")
      expect(compat19.qualification).toBe("SUPPORTED")

      const compatOld = classifyOpenCodeCompatibility("1.18.10")
      expect(compatOld.qualification).toBe("DEGRADED")
    })

    it("evaluates native background subagents truthfully without relying purely on semver", () => {
      const origNarrow = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
      const origBroad = process.env.OPENCODE_EXPERIMENTAL

      try {
        delete process.env.OPENCODE_EXPERIMENTAL
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true"
        const enabled = backgroundSubagentCapabilityCheck("1.18.20")
        expect(enabled.status).toBe("pass")
        expect(enabled.evidence?.featureEnabled).toBe(true)
        expect(enabled.evidence?.taskSchemaBackground).toBe(true)

        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "false"
        const disabled = backgroundSubagentCapabilityCheck("1.18.20")
        expect(disabled.status).toBe("warning")
        expect(disabled.evidence?.featureEnabled).toBe(false)
        expect(disabled.evidence?.taskSchemaBackground).toBe(false)
      } finally {
        if (origNarrow !== undefined) process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = origNarrow
        else delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
        if (origBroad !== undefined) process.env.OPENCODE_EXPERIMENTAL = origBroad
        else delete process.env.OPENCODE_EXPERIMENTAL
      }
    })

    it("evaluates native Code Mode truthfully and observes MCP-only tool boundary", () => {
      const origNarrow = process.env.OPENCODE_EXPERIMENTAL_CODE_MODE
      const origBroad = process.env.OPENCODE_EXPERIMENTAL

      try {
        delete process.env.OPENCODE_EXPERIMENTAL
        process.env.OPENCODE_EXPERIMENTAL_CODE_MODE = "true"
        const enabled = codeModeCapabilityCheck("1.18.20")
        expect(enabled.status).toBe("pass")
        expect(enabled.evidence?.executeToolAvailable).toBe("unknown")
        expect(enabled.evidence?.mcpOnlyBoundary).toBe(true)

        process.env.OPENCODE_EXPERIMENTAL_CODE_MODE = "false"
        const disabled = codeModeCapabilityCheck("1.18.20")
        expect(disabled.status).toBe("info")
        expect(disabled.evidence?.executeToolAvailable).toBe(false)
      } finally {
        if (origNarrow !== undefined) process.env.OPENCODE_EXPERIMENTAL_CODE_MODE = origNarrow
        else delete process.env.OPENCODE_EXPERIMENTAL_CODE_MODE
        if (origBroad !== undefined) process.env.OPENCODE_EXPERIMENTAL = origBroad
        else delete process.env.OPENCODE_EXPERIMENTAL
      }
    })
  })

  describe("Phase 3: Native Task Orchestration & Strict No-Polling", () => {
    it("normalizes native Task invocations with background=true and subagent_type", () => {
      const invocation = normalizeTaskInvocation(
        { sessionID: "ses-parent", callID: "call-1", agent: "heidi" },
        { subagent_type: "reviewer", prompt: "Review security and blast radius", background: true }
      )
      expect(invocation.callerAgent).toBe("heidi")
      expect(invocation.targetAgent).toBe("reviewer")
      expect(invocation.resolvedFrom).toBe("subagent_type")
      expect(invocation.background).toBe(true)
    })

    it("enforces strict no-polling and incremental result integration instructions in parallel prompt", () => {
      const prompt = buildTaskSpecificPromptSections("PARALLEL_SPECIALISTS")
      expect(prompt).toContain("Strict No-Polling: Do NOT use `heidi-agents` action=list to track native Task state")
      expect(prompt).toContain("NEVER fabricate, quote as live state, or emit `<task ...>` control envelopes")
      expect(prompt).toContain("Native Child Error Propagation: In OpenCode v1.18.20+")
      expect(prompt).toContain("Heidi integrates results incrementally as they arrive")
      expect(prompt).toContain("Native Status Todo: If results are pending, maintain a native Todo with `todowrite`")
    })

    it("orchestrates 3 background specialists with independent arrival and truthful packet state", () => {
      const parentSessionId = "ses-parent-3specialists"
      const now = Date.now()

      const coordinator = new HeidiActiveCoordinator({
        parentSessionId,
        runId: "run-triplet-1",
        goal: "Refactor core module with parallel specialists",
        coordinatorOwnership: {
          integrationScopes: ["src/index.ts"],
          readScopes: ["src/**"],
        },
        children: [
          { workstreamId: "child-reviewer", specialist: "reviewer", goal: "Review changes", access: "read", fileScopes: ["src/core/**"] },
          { workstreamId: "child-mapper", specialist: "mapper", goal: "Map symbols", access: "read", fileScopes: ["src/services/**"] },
          { workstreamId: "child-security", specialist: "security-auditor", goal: "Audit permissions", access: "read", fileScopes: ["src/security/**"] },
        ],
      })

      registerParallelCoordinator(parentSessionId, coordinator)

      try {
        // Step 1: Launch all 3 concurrently in background
        coordinator.markLaunched("child-reviewer")
        coordinator.markLaunched("child-mapper")
        coordinator.markLaunched("child-security")

        coordinator.recordChildLifecycleEvent({
          childId: "child-reviewer",
          kind: "child.started",
          snapshot: { childId: "child-reviewer", parentSessionId, specialist: "reviewer", state: "running", createdAt: now, startedAt: now, lastActivityAt: now }
        })
        coordinator.recordChildLifecycleEvent({
          childId: "child-mapper",
          kind: "child.started",
          snapshot: { childId: "child-mapper", parentSessionId, specialist: "mapper", state: "running", createdAt: now, startedAt: now, lastActivityAt: now }
        })
        coordinator.recordChildLifecycleEvent({
          childId: "child-security",
          kind: "child.started",
          snapshot: { childId: "child-security", parentSessionId, specialist: "security-auditor", state: "running", createdAt: now, startedAt: now, lastActivityAt: now }
        })

        let packet = renderParallelPacket(parentSessionId)
        expect(packet).toContain("child-reviewer(reviewer:running:pending)")
        expect(packet).toContain("child-mapper(mapper:running:pending)")
        expect(packet).toContain("child-security(security-auditor:running:pending)")
        expect(packet).toContain("Ready: 0")

        // Step 2: First specialist completes independently (incremental arrival)
        coordinator.recordChildLifecycleEvent({
          childId: "child-mapper",
          kind: "child.completed",
          snapshot: { childId: "child-mapper", parentSessionId, specialist: "mapper", state: "completed", createdAt: now, startedAt: now, finishedAt: now + 50, lastActivityAt: now + 50 }
        })

        packet = renderParallelPacket(parentSessionId)
        expect(packet).toContain("child-mapper(mapper:completed:ready)")
        expect(packet).toContain("Ready: 1")
        expect(packet).toContain("Next: integrate_ready")

        // Step 3: Second specialist completes
        coordinator.recordChildLifecycleEvent({
          childId: "child-reviewer",
          kind: "child.completed",
          snapshot: { childId: "child-reviewer", parentSessionId, specialist: "reviewer", state: "completed", createdAt: now, startedAt: now, finishedAt: now + 100, lastActivityAt: now + 100 }
        })

        packet = renderParallelPacket(parentSessionId)
        expect(packet).toContain("child-reviewer(reviewer:completed:ready)")
        expect(packet).toContain("Ready: 2")

        // Step 4: Third specialist completes -> Full convergence
        coordinator.recordChildLifecycleEvent({
          childId: "child-security",
          kind: "child.completed",
          snapshot: { childId: "child-security", parentSessionId, specialist: "security-auditor", state: "completed", createdAt: now, startedAt: now, finishedAt: now + 150, lastActivityAt: now + 150 }
        })

        packet = renderParallelPacket(parentSessionId)
        expect(packet).toContain("child-security(security-auditor:completed:ready)")
        expect(packet).toContain("Ready: 3")
      } finally {
        clearParallelCoordinator(parentSessionId)
      }
    })
  })

  describe("Phase 4: Code Mode Lazy Guidance & Boundary", () => {
    it("injects Code Mode instructions only when Code Mode is active and preserves MCP-only boundary", () => {
      const withCodeMode = buildTaskSpecificPromptSections("PARALLEL_SPECIALISTS", undefined, undefined, { codeModeAvailable: true, mcpCompositionCandidate: true })
      expect(withCodeMode).toContain("Native Code Mode (OpenCode execute tool)")
      expect(withCodeMode).toContain("Scope & Boundary: `execute` has access ONLY to connected, eligible MCP tools")
      expect(withCodeMode).toContain("Do NOT attempt to invoke internal plugin tools (fdx-*, native read, native shell)")

      const withoutCodeMode = buildTaskSpecificPromptSections("PARALLEL_SPECIALISTS", undefined, undefined, { codeModeAvailable: true, mcpCompositionCandidate: false })
      expect(withoutCodeMode).not.toContain("Native Code Mode (OpenCode execute tool)")
    })

    it("keeps FAST_DIRECT prompt minimal and under baseline budget", () => {
      const fastPrompt = buildHeidiCoordinatorPrompt(undefined, "FAST_DIRECT")
      expect(fastPrompt).not.toContain("Available Agents")
      expect(fastPrompt).not.toContain("Native Code Mode")
      expect(estimateCorePromptTokens()).toBeLessThan(600)
    })
  })
})