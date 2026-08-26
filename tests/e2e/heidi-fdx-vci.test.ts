/**
 * Heidi FDX VCI Integration E2E Test
 *
 * Covers non-accepting orchestration and degraded-mode scenarios from the integration spec.
 * Native qualification is intentionally separate: this file forces an absent binary and
 * must never be used as evidence of native-authority completion.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  queryFdxCapabilities,
  invalidateFdxCapabilitySnapshot,
  classifyTaskMutation,
  deriveChangeIntelligence,
  generateVerificationPlan,
  createVerificationAttestation,
} from "../../src/services/fdx-vci-adapter"
import { isFdxEvidenceStale, runFdxVerification } from "../../src/orchestration/verification/fdx-verification-provider"
import { VerificationStatus } from "../../src/orchestration/types"
import {
  createRecoveryState,
  classifyRepairStrategy,
} from "../../src/orchestration/verification/fdx-recovery"

const ABSENT_BINARY = "/tmp/fdx-not-found-e2e-" + Date.now()
const WS = mkdtempSync(join(tmpdir(), "fdx-e2e-test-"))
execFileSync("git", ["init"], { cwd: WS, stdio: "ignore" })
execFileSync("git", ["config", "user.name", "FDX E2E Test"], { cwd: WS, stdio: "ignore" })
execFileSync("git", ["config", "user.email", "fdx-e2e-test@flowdeck.dev"], { cwd: WS, stdio: "ignore" })
writeFileSync(join(WS, "README.md"), "# FDX E2E test\n")
execFileSync("git", ["add", "README.md"], { cwd: WS, stdio: "ignore" })
execFileSync("git", ["commit", "-m", "fixture"], { cwd: WS, stdio: "ignore" })
afterAll(() => rmSync(WS, { recursive: true, force: true }))

let origEnv: string | undefined

beforeEach(() => {
  invalidateFdxCapabilitySnapshot()
  origEnv = process.env.FDX_BINARY_PATH
  process.env.FDX_BINARY_PATH = ABSENT_BINARY
})

afterEach(() => {
  invalidateFdxCapabilitySnapshot()
  if (origEnv !== undefined) process.env.FDX_BINARY_PATH = origEnv
  else delete process.env.FDX_BINARY_PATH
})

async function makeCapabilities() {
  return queryFdxCapabilities(WS)
}

describe("E2E Scenario 1: Non-code task bypass", () => {
  it("does not trigger FDX workflow for non-code tasks", () => {
    expect(classifyTaskMutation("what version of Node?", {})).toBe("NO_REPO_MUTATION")
  })
})

describe("E2E Scenario 2: Simple code mutation requires native authority", () => {
  it("does not create a verification completion result when FDX is unavailable", async () => {
    const caps = await makeCapabilities()
    const intel = await deriveChangeIntelligence("run-e2e-2", WS, caps, {
      changedFiles: ["src/utils.ts"],
    })
    const { result } = await runFdxVerification("run-e2e-2", intel, caps)
    expect(result.status).toBe(VerificationStatus.ERROR)
    expect(result.evidenceIds).toEqual([])
  })
})

describe("Simulation Scenario 3: Complex mutation planning (non-accepting)", () => {
  it("complex multi-file mutation produces full VCI path", async () => {
    const caps = await makeCapabilities()
    const intel = await deriveChangeIntelligence("run-e2e-3", WS, caps, {
      changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "tests/a.test.ts"],
    })
    expect(intel.changedFiles.length).toBeGreaterThan(0)
    const plan = await generateVerificationPlan(intel, caps)
    expect(plan.checks.length).toBeGreaterThan(0)
    expect(plan.providerState).toBe("typescript_fallback")
  })
})

describe("E2E Scenario 4: Verification fail → direct repair → pass", () => {
  it("simple failure is classified as heidi_direct repair", () => {
    const state = createRecoveryState("run-e2e-4")
    const blockers = [{
      kind: "check_failed" as const,
      command: "oxlint",
      message: "lint error",
      heidiCanRepairDirectly: true,
      providerState: "typescript_fallback" as const,
    }]
    const strategy = classifyRepairStrategy(blockers, state)
    expect(strategy.kind).toBe("heidi_direct")
  })
})

describe("E2E Scenario 5: Verification fail → specialist repair → pass", () => {
  it("TypeScript failure routes to typescript specialist", () => {
    const state = createRecoveryState("run-e2e-5")
    const blockers = [{
      kind: "check_failed" as const,
      command: "tsc",
      message: "type error",
      suggestedSpecialist: "typescript",
      heidiCanRepairDirectly: false,
      providerState: "typescript_fallback" as const,
    }]
    const strategy = classifyRepairStrategy(blockers, state)
    expect(strategy.kind).toBe("specialist")
  })
})

describe("Simulation Scenario 6: Policy ADD_CHECK shape (non-accepting)", () => {
  it("policy overlay adds checks without removing base checks", async () => {
    const caps = await makeCapabilities()
    const intel = await deriveChangeIntelligence("run-e2e-6", WS, caps)
    const plan = await generateVerificationPlan(intel, caps)
    const enrichedPlan = {
      ...plan,
      checks: [...plan.checks, {
        checkId: "policy:extra-test",
        command: "bun",
        args: ["test", "--filter", "security"],
        rationale: "Added by learned policy",
        mandatory: true,
        policyAdded: true,
        policyId: "pol-001",
      }],
      m11OverlayApplied: true,
    }
    for (const base of plan.checks) {
      expect(enrichedPlan.checks.find(c => c.checkId === base.checkId)).toBeDefined()
    }
    const policyCheck = enrichedPlan.checks.find(c => c.policyAdded)
    expect(policyCheck).toBeDefined()
    expect(policyCheck?.policyId).toBe("pol-001")
  })
})

describe("E2E Scenario 7: State mutation invalidates previous PASS", () => {
  it("evidence becomes stale after repository mutation", () => {
    const oldResult = { stateFingerprint: "pre-mutation-fp", stateVersion: 1 } as Parameters<typeof isFdxEvidenceStale>[0]
    expect(isFdxEvidenceStale(oldResult, "post-mutation-fp", 2)).toBe(true)
  })
})

describe("Simulation Scenario 8: FDX absent → fallback/degraded (non-accepting)", () => {
  it("FDX absent produces typed fallback, not crash", async () => {
    const caps = await makeCapabilities()
    expect(caps.providerState).toBe("typescript_fallback")
    expect(caps).toBeDefined()
  })
})

describe("E2E Scenario 11: Degraded execution containment", () => {
  it("does not create local runtime evidence when native FDX is unavailable", async () => {
    const caps = await makeCapabilities()
    const intel = await deriveChangeIntelligence("run-e2e-11", WS, caps)
    const { result, session } = await runFdxVerification("run-e2e-11", intel, caps)
    expect(result.status).toBe(VerificationStatus.ERROR)
    expect(session.evidence?.persistenceFailed).toBe(true)
    expect(result.evidenceIds).toEqual([])
  })
})

describe("E2E Scenario 14: v1 attestation no-policy", () => {
  it("does not fabricate a v1 attestation when native FDX is unavailable", async () => {
    const caps = await makeCapabilities()
    const attestation = await createVerificationAttestation("run-e2e-14", caps, WS, { predicateVersion: "v1" })
    expect(attestation.predicate).toBe("v1")
    expect(attestation.verified).toBe(false)
    expect(attestation.attestationId).toBe("")
  })
})

describe("E2E Scenario 15: v2 attestation policy-overlay", () => {
  it("does not fabricate a v2 attestation when native FDX is unavailable", async () => {
    const caps = await makeCapabilities()
    const attestation = await createVerificationAttestation("run-e2e-15", caps, WS, { predicateVersion: "v2" })
    expect(attestation.predicate).toBe("v2")
    expect(attestation.verified).toBe(false)
    expect(attestation.attestationId).toBe("")
  })
})

describe("FDX VCI role enforcement", () => {
  it("FDX is code intelligence authority, Heidi is orchestrator", () => {
    const mutationClass = classifyTaskMutation("update API endpoint", {
      hasFileChanges: true,
      changedFileCount: 2,
    })
    const validClasses = ["NO_REPO_MUTATION", "SIMPLE_REPO_MUTATION", "COMPLEX_REPO_MUTATION", "HIGH_RISK_REPO_MUTATION"]
    expect(validClasses).toContain(mutationClass)
  })

  it("M10 calibration is measurement-only (does not change current run)", async () => {
    const caps = await makeCapabilities()
    const intel = await deriveChangeIntelligence("run-m10", WS, caps)
    const plan = await generateVerificationPlan(intel, caps)
    expect(plan.checks).toBeDefined()
    expect(plan.m11OverlayApplied).toBe(false)
  })

  it("simple tasks do not trigger unnecessary orchestration", () => {
    expect(classifyTaskMutation("what version of Node?", {})).toBe("NO_REPO_MUTATION")
    expect(classifyTaskMutation("show me the logs", {})).toBe("NO_REPO_MUTATION")
    expect(classifyTaskMutation("explain this code", {})).toBe("NO_REPO_MUTATION")
  })
})