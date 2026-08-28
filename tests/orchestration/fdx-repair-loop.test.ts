/**
 * FDX Repair Loop Tests
 */

import { describe, it, expect } from "bun:test"
import {
  createRecoveryState,
  canContinueRecovery,
  recordRecoveryAttempt,
  classifyRepairStrategy,
  shouldSurfaceM11Candidates,
} from "../../src/orchestration/verification/fdx-recovery"
import type { FdxCapabilitySnapshot, FdxVerificationPlan, FdxVerificationBlocker } from "../../src/services/fdx-vci-adapter"

const mockCaps = (providerState = "typescript_fallback"): FdxCapabilitySnapshot => ({
  snapshotId: "test",
  capturedAt: new Date().toISOString(),
  providerState: providerState as FdxCapabilitySnapshot["providerState"],
  verificationPredicateVersions: [],
  calibrationContractVersions: [],
  policyContractVersions: providerState === "native_vci_full" ? [1] : [],
  assuranceLevels: [],
  networkAccess: false,
  telemetry: false,
  platformLimitations: [],
  missingCapabilities: [],
})

const mockPlan = (overrides: Partial<FdxVerificationPlan> = {}): FdxVerificationPlan => ({
  planId: "plan-001",
  runId: "run-001",
  basePlanDigest: "base",
  effectivePlanDigest: "effective",
  checks: [],
  m11OverlayApplied: false,
  m11CandidatesAvailable: [],
  providerState: "typescript_fallback",
  assurance: "EXACT",
  ...overrides,
})

const blocker = (overrides: Partial<FdxVerificationBlocker> = {}): FdxVerificationBlocker => ({
  kind: "check_failed",
  message: "test failure",
  heidiCanRepairDirectly: true,
  providerState: "typescript_fallback",
  ...overrides,
})

describe("Recovery convergence bounds", () => {
  it("allows initial recovery attempt", () => {
    const state = createRecoveryState("run-001")
    expect(canContinueRecovery(state, "strategy-1").canContinue).toBe(true)
  })

  it("stops after maxAttempts reached", () => {
    let state = createRecoveryState("run-001", { maxAttempts: 3 })
    state = recordRecoveryAttempt(state, "s1")
    state = recordRecoveryAttempt(state, "s2")
    state = recordRecoveryAttempt(state, "s3")
    const check = canContinueRecovery(state, "s4")
    expect(check.canContinue).toBe(false)
    expect(check.reason).toContain("max attempts")
  })

  it("stops after wall-clock budget exhausted", () => {
    // Create state with startedAt in the past to ensure budget is actually exhausted
    const state = {
      ...createRecoveryState("run-001"),
      startedAt: Date.now() - 1000000, // 1000 seconds ago
      bounds: { maxAttempts: 10, wallClockBudgetMs: 100 }, // 100ms budget — already expired
      strategyHistory: [],
      status: "active" as const,
    }
    const check = canContinueRecovery(state, "s1")
    expect(check.canContinue).toBe(false)
    expect(check.reason).toContain("Wall-clock budget")
  })

  it("stops after repeated identical strategy", () => {
    let state = createRecoveryState("run-001")
    state = recordRecoveryAttempt(state, "same-strategy")
    state = recordRecoveryAttempt(state, "same-strategy")
    const check = canContinueRecovery(state, "same-strategy")
    expect(check.canContinue).toBe(false)
    expect(check.reason).toContain("Repeated identical failure")
  })

  it("allows different strategies", () => {
    let state = createRecoveryState("run-001")
    state = recordRecoveryAttempt(state, "strategy-a")
    const check = canContinueRecovery(state, "strategy-b")
    expect(check.canContinue).toBe(true)
  })
})

describe("Repair strategy classification", () => {
  it("heidi repairs directly for simple lint failures", () => {
    const state = createRecoveryState("run-001")
    const blockers = [
      blocker({ kind: "check_failed", command: "oxlint", heidiCanRepairDirectly: true }),
    ]
    const strategy = classifyRepairStrategy(blockers, state)
    expect(strategy.kind).toBe("heidi_direct")
  })

  it("routes to specialist for typecheck failures", () => {
    const state = createRecoveryState("run-001")
    const blockers = [
      blocker({ kind: "check_failed", suggestedSpecialist: "typescript", heidiCanRepairDirectly: false }),
    ]
    const strategy = classifyRepairStrategy(blockers, state)
    expect(strategy.kind).toBe("specialist")
    if (strategy.kind === "specialist") {
      expect(strategy.domain).toBe("typescript")
    }
  })

  it("routes to specialist for Rust failures", () => {
    const state = createRecoveryState("run-001")
    const blockers = [
      blocker({ kind: "check_failed", suggestedSpecialist: "rust", heidiCanRepairDirectly: false }),
    ]
    const strategy = classifyRepairStrategy(blockers, state)
    expect(strategy.kind).toBe("specialist")
    if (strategy.kind === "specialist") {
      expect(strategy.domain).toBe("rust")
    }
  })

  it("complex failures require Repo Master consultation", () => {
    const state = createRecoveryState("run-001")
    const blockers = [
      blocker({ kind: "check_failed", suggestedSpecialist: "typescript", heidiCanRepairDirectly: false }),
      blocker({ kind: "unresolved_obligation", heidiCanRepairDirectly: false }),
      blocker({ kind: "check_failed", suggestedSpecialist: "rust", heidiCanRepairDirectly: false }),
    ]
    const strategy = classifyRepairStrategy(blockers, state)
    if (strategy.kind === "specialist") {
      expect(strategy.requiresRepoMaster).toBe(true)
    }
  })

  it("provider_unavailable routes to heidi_direct", () => {
    const state = createRecoveryState("run-001")
    const blockers = [
      blocker({ kind: "provider_unavailable", heidiCanRepairDirectly: false }),
    ]
    const strategy = classifyRepairStrategy(blockers, state)
    expect(strategy.kind).toBe("heidi_direct")
  })
})

describe("M11 candidate surfacing", () => {
  it("does not surface candidates in typescript_fallback mode", () => {
    const caps = mockCaps("typescript_fallback")
    const plan = mockPlan({ m11CandidatesAvailable: ["pol-001"] })
    expect(shouldSurfaceM11Candidates(plan, caps)).toBe(false)
  })

  it("surfaces candidates when native and policy supported", () => {
    const caps = mockCaps("native_vci_full")
    const plan = mockPlan({ m11CandidatesAvailable: ["pol-001"] })
    expect(shouldSurfaceM11Candidates(plan, caps)).toBe(true)
  })

  it("does not surface empty candidate list", () => {
    const caps = mockCaps("native_vci_full")
    const plan = mockPlan({ m11CandidatesAvailable: [] })
    expect(shouldSurfaceM11Candidates(plan, caps)).toBe(false)
  })
})