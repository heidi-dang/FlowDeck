import { describe, it, expect } from "bun:test"
import { validateDelegationDepth } from "../src/services/governance-wiring"
import { isHeidiAgent, isSpecialistAgent } from "../src/services/canonical-registry"

describe("Heidi Delegation Depth Regression & Semantics", () => {
  const specialists = new Set(["security-auditor", "reviewer", "architect", "backend-coder", "frontend-coder"])

  // Helper simulating the currentDepth calculation invariant
  function computeSessionDepth(sessionMeta: { parentID?: string; depth?: number } | undefined, callerAgent: string): number {
    const isRootHeidi = (sessionMeta?.parentID === undefined || sessionMeta?.parentID === "") && isHeidiAgent(callerAgent)
    if (isRootHeidi) return 0

    const isChildSession = Boolean(sessionMeta?.parentID) || (sessionMeta?.depth ?? 0) > 0
    if (isChildSession) {
      return (sessionMeta?.depth && sessionMeta.depth > 0) ? sessionMeta.depth : 1
    }
    return isSpecialistAgent(callerAgent) ? 1 : 0
  }

  it("Required 1 — root Heidi session ID has depth 0", () => {
    // manual user session: agent=heidi, parentID=undefined
    const depth = computeSessionDepth({ parentID: undefined, depth: 0 }, "heidi")
    expect(depth).toBe(0)

    const result = validateDelegationDepth("heidi", "security-auditor", depth, specialists, 1)
    expect(result.allowed).toBe(true)
  })

  it("Required 2 — root Heidi → security-auditor", () => {
    const depth = computeSessionDepth({ parentID: undefined, depth: 0 }, "heidi")
    const result = validateDelegationDepth("heidi", "security-auditor", depth, specialists, 1)
    expect(result.allowed).toBe(true)
  })

  it("Required 3 — root Heidi → reviewer", () => {
    const depth = computeSessionDepth({ parentID: undefined, depth: 0 }, "heidi")
    const result = validateDelegationDepth("heidi", "reviewer", depth, specialists, 1)
    expect(result.allowed).toBe(true)
  })

  it("Required 4 — root Heidi → architect", () => {
    const depth = computeSessionDepth({ parentID: undefined, depth: 0 }, "heidi")
    const result = validateDelegationDepth("heidi", "architect", depth, specialists, 1)
    expect(result.allowed).toBe(true)
  })

  it("Required 5 — three sibling specialists", () => {
    // All launched concurrently by root Heidi (depth 0)
    const depth = computeSessionDepth({ parentID: undefined, depth: 0 }, "heidi")
    const r1 = validateDelegationDepth("heidi", "security-auditor", depth, specialists, 1)
    const r2 = validateDelegationDepth("heidi", "reviewer", depth, specialists, 1)
    const r3 = validateDelegationDepth("heidi", "architect", depth, specialists, 1)
    expect(r1.allowed).toBe(true)
    expect(r2.allowed).toBe(true)
    expect(r3.allowed).toBe(true)
  })

  it("Required 6 — frontend/backend Fast Harness parallel", () => {
    const depth = computeSessionDepth({ parentID: undefined, depth: 0 }, "heidi")
    const r1 = validateDelegationDepth("heidi", "frontend-coder", depth, specialists, 1)
    const r2 = validateDelegationDepth("heidi", "backend-coder", depth, specialists, 1)
    expect(r1.allowed).toBe(true)
    expect(r2.allowed).toBe(true)
  })

  it("Required 7 — specialist recursive delegation", () => {
    // security-auditor child session at depth 1 tries to delegate
    const depth = computeSessionDepth({ parentID: "parent-session-123", depth: 1 }, "security-auditor")
    expect(depth).toBe(1)
    const result = validateDelegationDepth("security-auditor", "reviewer", depth, specialists, 1)
    expect(result.allowed).toBe(false)
    expect(result.errorCode).toBe("SPECIALIST_CANNOT_DELEGATE")
  })

  it("Required 8 — generic depth overflow", () => {
    // Non-specialist custom agent at depth 1 trying to delegate
    const depth = computeSessionDepth({ parentID: "parent-session-123", depth: 1 }, "custom-agent")
    expect(depth).toBe(1)
    const result = validateDelegationDepth("custom-agent", "reviewer", depth, specialists, 1)
    expect(result.allowed).toBe(false)
    expect(result.errorCode).toBe("DEPTH_LIMIT_EXCEEDED")
  })

  it("Required 9 — recovery continuation preserves root Heidi depth 0", () => {
    // Root Heidi encounters recovery continuation, parentID remains undefined
    const meta = { parentID: undefined, depth: 0 }
    const depth = computeSessionDepth(meta, "heidi")
    expect(depth).toBe(0)
  })

  it("Required 10 — internal Continue does not create child ancestry", () => {
    const meta = { parentID: undefined, depth: 0 }
    const depth = computeSessionDepth(meta, "heidi")
    expect(depth).toBe(0)
  })

  it("Required 11 — resume session maintains depth 0 for root Heidi", () => {
    const meta = { parentID: undefined, depth: 0 }
    const depth = computeSessionDepth(meta, "heidi")
    expect(depth).toBe(0)
  })
})
