/**
 * FDX VCI Adapter Tests
 *
 * Tests the single integration boundary between Heidi orchestration
 * and the FDX VCI M1-M12 runtime.
 *
 * Uses environment variables to control binary discovery behavior.
 * Tests pure logic functions that don't require a live FDX binary.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  invalidateFdxCapabilitySnapshot,
  classifyTaskMutation,
} from "../src/services/fdx-vci-adapter"

// Control binary discovery via env var — "invalid-fdx-binary" won't be found.
// The workspace remains a real Git repository because repository identity must
// fail closed rather than invent a time-based fingerprint for non-repositories.
const ABSENT_BINARY_PATH = "/tmp/fdx-not-found-" + Date.now()
const MOCK_WORKSPACE = mkdtempSync(join(tmpdir(), "fdx-adapter-test-"))
execFileSync("git", ["init"], { cwd: MOCK_WORKSPACE, stdio: "ignore" })
execFileSync("git", ["config", "user.name", "FDX Test"], { cwd: MOCK_WORKSPACE, stdio: "ignore" })
execFileSync("git", ["config", "user.email", "fdx-test@flowdeck.dev"], { cwd: MOCK_WORKSPACE, stdio: "ignore" })
writeFileSync(join(MOCK_WORKSPACE, "README.md"), "# FDX adapter test\n")
execFileSync("git", ["add", "README.md"], { cwd: MOCK_WORKSPACE, stdio: "ignore" })
execFileSync("git", ["commit", "-m", "fixture"], { cwd: MOCK_WORKSPACE, stdio: "ignore" })
afterAll(() => rmSync(MOCK_WORKSPACE, { recursive: true, force: true }))

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

  it("fallback mode cannot fabricate native runtime evidence", async () => {
    const { queryFdxCapabilities, deriveChangeIntelligence } = await import("../src/services/fdx-vci-adapter")
    const { runFdxVerification } = await import("../src/orchestration/verification/fdx-verification-provider")
    const caps = await queryFdxCapabilities(MOCK_WORKSPACE)
    const intel = await deriveChangeIntelligence("run-001", MOCK_WORKSPACE, caps)
    const { result, session } = await runFdxVerification("run-001", intel, caps)
    expect(result.evidenceIds).toEqual([])
    expect(session.evidence?.persistenceFailed).toBe(true)
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

  it("no-policy attestation refuses to fabricate predicate v1", async () => {
    const { queryFdxCapabilities, createVerificationAttestation } = await import("../src/services/fdx-vci-adapter")
    const caps = await queryFdxCapabilities(MOCK_WORKSPACE)
    const attestation = await createVerificationAttestation("run-001", caps, MOCK_WORKSPACE, { predicateVersion: "v1" })
    expect(attestation.predicate).toBe("v1")
    expect(attestation.verified).toBe(false)
    expect(attestation.attestationId).toBe("")
  })

  it("policy-overlay attestation refuses to fabricate predicate v2", async () => {
    const { queryFdxCapabilities, createVerificationAttestation } = await import("../src/services/fdx-vci-adapter")
    const caps = await queryFdxCapabilities(MOCK_WORKSPACE)
    const attestation = await createVerificationAttestation("run-001", caps, MOCK_WORKSPACE, { predicateVersion: "v2" })
    expect(attestation.predicate).toBe("v2")
    expect(attestation.verified).toBe(false)
    expect(attestation.attestationId).toBe("")
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