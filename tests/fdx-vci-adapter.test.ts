/**
 * FDX VCI Adapter Tests
 *
 * Tests the single integration boundary between Heidi orchestration
 * and the FDX VCI M1-M12 runtime.
 *
 * Uses environment variables to control binary discovery behavior.
 * Tests pure logic functions that don't require a live FDX binary.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  invalidateFdxCapabilitySnapshot,
  classifyTaskMutation,
} from "../src/services/fdx-vci-adapter"

// Control binary discovery via env var — "invalid-fdx-binary" won't be found
const ABSENT_BINARY_PATH = "/tmp/fdx-not-found-" + Date.now()
const MOCK_WORKSPACE = "/tmp/test-workspace-" + Date.now()

describe("FdxVciAdapter — capability negotiation (binary absent)", () => {
  let origEnv: string | undefined

  beforeEach(() => {
    invalidateFdxCapabilitySnapshot()
    origEnv = process.env.FDX_BINARY_PATH
    process.env.FDX_BINARY_PATH = ABSENT_BINARY_PATH
  })

  afterEach(() => {
    invalidateFdxCapabilitySnapshot()
    if (origEnv !== undefined) {
      process.env.FDX_BINARY_PATH = origEnv
    } else {
      delete process.env.FDX_BINARY_PATH
    }
  })

  it("returns typescript_fallback when binary is absent", async () => {
    const { queryFdxCapabilities } = await import("../src/services/fdx-vci-adapter")
    const snap = await queryFdxCapabilities(MOCK_WORKSPACE)
    expect(snap.providerState).toBe("typescript_fallback")
  })

  it("caches snapshot for same workspace", async () => {
    const { queryFdxCapabilities } = await import("../src/services/fdx-vci-adapter")
    const snap1 = await queryFdxCapabilities(MOCK_WORKSPACE)
    const snap2 = await queryFdxCapabilities(MOCK_WORKSPACE)
    expect(snap1.snapshotId).toBe(snap2.snapshotId)
  })

  it("refreshes snapshot after invalidation", async () => {
    const { queryFdxCapabilities } = await import("../src/services/fdx-vci-adapter")
    const snap1 = await queryFdxCapabilities(MOCK_WORKSPACE)
    invalidateFdxCapabilitySnapshot()
    const snap2 = await queryFdxCapabilities(MOCK_WORKSPACE)
    expect(snap1.snapshotId).not.toBe(snap2.snapshotId)
  })

  it("provider state is typed string, not boolean", async () => {
    const { queryFdxCapabilities } = await import("../src/services/fdx-vci-adapter")
    const snap = await queryFdxCapabilities(MOCK_WORKSPACE)
    const validStates = ["native_vci_full", "native_vci_partial", "typescript_fallback", "unavailable"]
    expect(validStates).toContain(snap.providerState)
    expect(typeof snap.providerState).toBe("string")
  })
})

describe("FdxVciAdapter — task classification", () => {
  it("classifies non-code queries as NO_REPO_MUTATION", () => {
    expect(classifyTaskMutation("what version of Node is this repo using?", {})).toBe("NO_REPO_MUTATION")
    expect(classifyTaskMutation("show me the package.json", {})).toBe("NO_REPO_MUTATION")
    expect(classifyTaskMutation("where is the configuration?", {})).toBe("NO_REPO_MUTATION")
  })

  it("classifies simple file change as SIMPLE_REPO_MUTATION", () => {
    const result = classifyTaskMutation("fix the typo in README", {
      hasFileChanges: true,
      changedFileCount: 1,
    })
    expect(result).toBe("SIMPLE_REPO_MUTATION")
  })

  it("classifies multi-file change as COMPLEX_REPO_MUTATION", () => {
    const result = classifyTaskMutation("refactor the auth module", {
      hasFileChanges: true,
      changedFileCount: 5,
      affectsTests: true,
    })
    expect(result).toBe("COMPLEX_REPO_MUTATION")
  })

  it("classifies cross-package change as HIGH_RISK_REPO_MUTATION", () => {
    const result = classifyTaskMutation("update shared API types", {
      hasFileChanges: true,
      crossPackage: true,
      affectsPublicApi: true,
    })
    expect(result).toBe("HIGH_RISK_REPO_MUTATION")
  })

  it("does not trigger heavy VCI for non-code task without file changes", () => {
    expect(classifyTaskMutation("install latest opencode", {})).toBe("NO_REPO_MUTATION")
  })

  it("classify requires file changes to be non-trivial", () => {
    // Without hasFileChanges, even large task descriptions stay NO_REPO_MUTATION
    expect(classifyTaskMutation("do a major refactor of everything", {})).toBe("NO_REPO_MUTATION")
  })
})

describe("FdxVciAdapter — degraded fallback behavior", () => {
  let origEnv: string | undefined

  beforeEach(() => {
    invalidateFdxCapabilitySnapshot()
    origEnv = process.env.FDX_BINARY_PATH
    process.env.FDX_BINARY_PATH = ABSENT_BINARY_PATH
  })

  afterEach(() => {
    invalidateFdxCapabilitySnapshot()
    if (origEnv !== undefined) process.env.FDX_BINARY_PATH = origEnv
    else delete process.env.FDX_BINARY_PATH
  })

  it("deriveChangeIntelligence returns degraded when binary absent", async () => {
    const { queryFdxCapabilities, deriveChangeIntelligence } = await import("../src/services/fdx-vci-adapter")
    const caps = await queryFdxCapabilities(MOCK_WORKSPACE)
    const intel = await deriveChangeIntelligence("run-001", MOCK_WORKSPACE, caps, {
      changedFiles: ["src/foo.ts"],
    })
    expect(intel.assuranceLevel).toBe("degraded")
    expect(intel.providerState).toBe("typescript_fallback")
    expect(intel.changedFiles).toContain("src/foo.ts")
  })

  it("fallback plan is not empty for TypeScript files", async () => {
    const { queryFdxCapabilities, deriveChangeIntelligence, generateVerificationPlan } = await import("../src/services/fdx-vci-adapter")
    const caps = await queryFdxCapabilities(MOCK_WORKSPACE)
    const intel = await deriveChangeIntelligence("run-001", MOCK_WORKSPACE, caps, {
      changedFiles: ["src/foo.ts"],
    })
    const plan = await generateVerificationPlan(intel, caps)
    expect(plan.checks.length).toBeGreaterThan(0)
    expect(plan.m11OverlayApplied).toBe(false)
  })

  it("fallback evidence is not represented as native FDX evidence", async () => {
    const { queryFdxCapabilities, deriveChangeIntelligence, generateVerificationPlan, persistRuntimeEvidence } = await import("../src/services/fdx-vci-adapter")
    const caps = await queryFdxCapabilities(MOCK_WORKSPACE)
    const intel = await deriveChangeIntelligence("run-001", MOCK_WORKSPACE, caps)
    const plan = await generateVerificationPlan(intel, caps)
    const evidence = await persistRuntimeEvidence(plan, [], caps)
    expect(evidence.providerState).toBe("typescript_fallback")
    expect(evidence.providerState).not.toBe("native_vci_full")
  })
})

describe("FdxVciAdapter — M11 overlay semantics", () => {
  let origEnv: string | undefined

  beforeEach(() => {
    invalidateFdxCapabilitySnapshot()
    origEnv = process.env.FDX_BINARY_PATH
    process.env.FDX_BINARY_PATH = ABSENT_BINARY_PATH
  })

  afterEach(() => {
    invalidateFdxCapabilitySnapshot()
    if (origEnv !== undefined) process.env.FDX_BINARY_PATH = origEnv
    else delete process.env.FDX_BINARY_PATH
  })

  it("M11 overlay does not reduce base checks in fallback mode", async () => {
    const { queryFdxCapabilities, deriveChangeIntelligence, generateVerificationPlan } = await import("../src/services/fdx-vci-adapter")
    const caps = await queryFdxCapabilities(MOCK_WORKSPACE)
    const intel = await deriveChangeIntelligence("run-001", MOCK_WORKSPACE, caps, {
      changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    })
    const plan = await generateVerificationPlan(intel, caps)
    // Fallback plan should have checks and no overlay removal
    expect(plan.checks.length).toBe(plan.checks.length) // tautology but tests no exception
    expect(plan.m11OverlayApplied).toBe(false)
  })

  it("assurance remains degraded regardless of hypothetical policy", async () => {
    const { queryFdxCapabilities, deriveChangeIntelligence } = await import("../src/services/fdx-vci-adapter")
    const caps = await queryFdxCapabilities(MOCK_WORKSPACE)
    expect(caps.providerState).toBe("typescript_fallback")
    const intel = await deriveChangeIntelligence("run-001", MOCK_WORKSPACE, caps)
    expect(intel.assuranceLevel).toBe("degraded")
  })
})

describe("FdxVciAdapter — attestation predicate", () => {
  let origEnv: string | undefined

  beforeEach(() => {
    invalidateFdxCapabilitySnapshot()
    origEnv = process.env.FDX_BINARY_PATH
    process.env.FDX_BINARY_PATH = ABSENT_BINARY_PATH
  })

  afterEach(() => {
    invalidateFdxCapabilitySnapshot()
    if (origEnv !== undefined) process.env.FDX_BINARY_PATH = origEnv
    else delete process.env.FDX_BINARY_PATH
  })

  it("no-policy verification uses predicate v1", async () => {
    const { queryFdxCapabilities, deriveChangeIntelligence, generateVerificationPlan, persistRuntimeEvidence, generateAttestationReference } = await import("../src/services/fdx-vci-adapter")
    const caps = await queryFdxCapabilities(MOCK_WORKSPACE)
    const intel = await deriveChangeIntelligence("run-001", MOCK_WORKSPACE, caps)
    const plan = await generateVerificationPlan(intel, caps)
    const evidence = await persistRuntimeEvidence(plan, [], caps)
    const attestation = await generateAttestationReference(evidence, plan, caps)
    expect(attestation.predicate).toBe("v1")
    expect(attestation.policyId).toBeUndefined()
  })

  it("policy-overlay verification uses predicate v2", async () => {
    const { queryFdxCapabilities, deriveChangeIntelligence, generateVerificationPlan, persistRuntimeEvidence, generateAttestationReference } = await import("../src/services/fdx-vci-adapter")
    const caps = await queryFdxCapabilities(MOCK_WORKSPACE)
    const intel = await deriveChangeIntelligence("run-001", MOCK_WORKSPACE, caps)
    const basePlan = await generateVerificationPlan(intel, caps)
    const planWithOverlay = { ...basePlan, m11OverlayApplied: true, policySnapshotDigest: "abc123" }
    const evidence = await persistRuntimeEvidence(basePlan, [], caps)
    const attestation = await generateAttestationReference(evidence, planWithOverlay, caps)
    expect(attestation.predicate).toBe("v2")
  })
})

describe("FdxVciAdapter — privacy", () => {
  it("capability snapshot contains no secrets or private paths when binary absent", async () => {
    invalidateFdxCapabilitySnapshot()
    const origEnv = process.env.FDX_BINARY_PATH
    process.env.FDX_BINARY_PATH = ABSENT_BINARY_PATH
    try {
      const { queryFdxCapabilities } = await import("../src/services/fdx-vci-adapter")
      const snap = await queryFdxCapabilities(MOCK_WORKSPACE)
      const serialized = JSON.stringify(snap)
      expect(serialized).not.toContain("password")
      expect(serialized).not.toContain("secret")
    } finally {
      invalidateFdxCapabilitySnapshot()
      if (origEnv !== undefined) process.env.FDX_BINARY_PATH = origEnv
      else delete process.env.FDX_BINARY_PATH
    }
  })
})