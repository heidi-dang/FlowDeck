/**
 * FDX Verification Authority Tests
 */

import { describe, it, expect } from "bun:test"
import { isFdxEvidenceStale } from "../../src/orchestration/verification/fdx-verification-provider"
import {
  classifyVerificationFailures,
} from "../../src/services/fdx-vci-adapter"
import type { FdxCapabilitySnapshot, FdxVerificationPlan, FdxRuntimeEvidence } from "../../src/services/fdx-vci-adapter"

const mockCaps = (providerState = "typescript_fallback"): FdxCapabilitySnapshot => ({
  snapshotId: "test-snap",
  capturedAt: new Date().toISOString(),
  providerState: providerState as FdxCapabilitySnapshot["providerState"],
  verificationPredicateVersions: providerState.includes("native") ? ["v1", "v2"] : [],
  calibrationContractVersions: [],
  policyContractVersions: [],
  assuranceLevels: [],
  networkAccess: false,
  telemetry: false,
  platformLimitations: [],
  missingCapabilities: [],
})

const mockPlan = (overrides: Partial<FdxVerificationPlan> = {}): FdxVerificationPlan => ({
  planId: "plan-001",
  runId: "run-001",
  basePlanDigest: "base-digest",
  effectivePlanDigest: "effective-digest",
  checks: [],
  m11OverlayApplied: false,
  m11CandidatesAvailable: [],
  providerState: "typescript_fallback",
  assurance: "EXACT",
  ...overrides,
})

const mockEvidence = (overrides: Partial<FdxRuntimeEvidence> = {}): FdxRuntimeEvidence => ({
  runId: "run-001",
  verificationRunId: "vrun-001",
  stateFingerprint: "fingerprint-001",
  outcome: "passed",
  assurance: "EXACT",
  checksPassed: 3,
  checksFailed: 0,
  checksSkipped: 0,
  mandatoryPassed: true,
  mandatoryFailed: false,
  failureReasons: [],
  evidenceDigest: "evidence-digest",
  persistenceFailed: false,
  checkResults: [],
  unresolvedObligations: [],
  providerState: "typescript_fallback",
  ...overrides,
})

describe("FDX Evidence Staleness", () => {
  it("rejects evidence with different state fingerprint", () => {
    const result = { stateFingerprint: "old-fp", stateVersion: 1 } as Parameters<typeof isFdxEvidenceStale>[0]
    expect(isFdxEvidenceStale(result, "new-fp", 1)).toBe(true)
  })

  it("rejects evidence with older state version", () => {
    const result = { stateFingerprint: "fp-001", stateVersion: 1 } as Parameters<typeof isFdxEvidenceStale>[0]
    expect(isFdxEvidenceStale(result, "fp-001", 2)).toBe(true)
  })

  it("accepts evidence with matching state", () => {
    const result = { stateFingerprint: "fp-001", stateVersion: 2 } as Parameters<typeof isFdxEvidenceStale>[0]
    expect(isFdxEvidenceStale(result, "fp-001", 2)).toBe(false)
  })

  it("rejects evidence missing stateFingerprint", () => {
    const result = { stateVersion: 1 } as Parameters<typeof isFdxEvidenceStale>[0]
    expect(isFdxEvidenceStale(result, "fp-001", 1)).toBe(true)
  })

  it("rejects evidence missing stateVersion", () => {
    const result = { stateFingerprint: "fp-001" } as Parameters<typeof isFdxEvidenceStale>[0]
    expect(isFdxEvidenceStale(result, "fp-001", 1)).toBe(true)
  })
})

describe("FDX Verification Failure Classification", () => {
  it("provider_unavailable blocker prevents false completion", () => {
    const caps = mockCaps("unavailable")
    const plan = mockPlan()
    const evidence = mockEvidence({ mandatoryFailed: true, failureReasons: ["provider gone"] })
    const blockers = classifyVerificationFailures(evidence, plan, caps)
    expect(blockers.some(b => b.kind === "provider_unavailable")).toBe(true)
    const unavailableBlocker = blockers.find(b => b.kind === "provider_unavailable")
    expect(unavailableBlocker?.heidiCanRepairDirectly).toBe(false)
  })

  it("degraded provider generates provider_degraded blocker", () => {
    const caps = mockCaps("typescript_fallback")
    const plan = mockPlan()
    const evidence = mockEvidence({ failureReasons: [] })
    const blockers = classifyVerificationFailures(evidence, plan, caps)
    expect(blockers.some(b => b.kind === "provider_degraded")).toBe(true)
  })

  it("check_failed blocker is generated for failed mandatory checks", () => {
    const caps = mockCaps("typescript_fallback")
    const plan = mockPlan({
      checks: [{
        checkId: "typecheck",
        command: "bun",
        args: ["tsc", "--noEmit"],
        rationale: "TypeScript type check",
        mandatory: true,
        policyAdded: false,
      }]
    })
    const evidence = mockEvidence({ failureReasons: ["check typecheck failed"] })
    const blockers = classifyVerificationFailures(evidence, plan, caps)
    expect(blockers.some(b => b.kind === "check_failed" || b.kind === "provider_degraded")).toBe(true)
  })
})

describe("FDX M11 Overlay — ADD_CHECK only invariant", () => {
  it("M11 overlay must not remove existing checks", () => {
    const plan = mockPlan({
      checks: [
        { checkId: "check-a", command: "bun", args: ["test"], rationale: "Base", mandatory: true, policyAdded: false },
        { checkId: "check-b", command: "tsc", args: ["--noEmit"], rationale: "Base", mandatory: true, policyAdded: false },
        { checkId: "check-c", command: "oxlint", args: ["."], rationale: "Base", mandatory: false, policyAdded: false },
      ],
      m11OverlayApplied: true,
    })
    expect(plan.checks.find(c => c.checkId === "check-a")).toBeDefined()
    expect(plan.checks.find(c => c.checkId === "check-b")).toBeDefined()
    expect(plan.checks.find(c => c.checkId === "check-c")).toBeDefined()
  })

  it("policy-added checks are distinguishable from base checks", () => {
    const plan = mockPlan({
      checks: [
        { checkId: "base-check", command: "bun", args: ["test"], rationale: "Base", mandatory: true, policyAdded: false },
        { checkId: "policy-check", command: "cargo", args: ["test"], rationale: "Policy", mandatory: true, policyAdded: true, policyId: "pol-001" },
      ],
      m11OverlayApplied: true,
    })
    const baseCheck = plan.checks.find(c => c.checkId === "base-check")
    const policyCheck = plan.checks.find(c => c.checkId === "policy-check")
    expect(baseCheck?.policyAdded).toBe(false)
    expect(policyCheck?.policyAdded).toBe(true)
    expect(policyCheck?.policyId).toBe("pol-001")
  })
})

describe("CompletionPolicy — FDX authority gate", () => {
  it("stale FDX evidence prevents completion", () => {
    const oldResult = { stateFingerprint: "old-fp", stateVersion: 1 } as Parameters<typeof isFdxEvidenceStale>[0]
    const stale = isFdxEvidenceStale(oldResult, "new-fp-after-mutation", 2)
    expect(stale).toBe(true)
  })

  it("valid FDX pass evidence enables completion evaluation", () => {
    const result = { stateFingerprint: "fp-001", stateVersion: 1 } as Parameters<typeof isFdxEvidenceStale>[0]
    const stale = isFdxEvidenceStale(result, "fp-001", 1)
    expect(stale).toBe(false)
  })
})
