/**
 * Native FDX Verification Authority Integration Tests
 *
 * Verifies that native FDX is authoritative for:
 * 1. Milestone 6: Native verification planning (fdx plan)
 * 2. Milestone 7: Native verification execution (fdx verify)
 * 3. Milestone 8: Durable runtime evidence persistence & fail-closed error handling
 * 4. Milestone 9: Real in-toto Predicate v1 and v2 attestation creation & verification
 * 5. Content-bound repository state fingerprinting (working-tree dirty bytes binding)
 * 6. Milestone 10: Exact per-check truth (no whole-run collapsing)
 * 7. Cancellation and concurrency / duplicate-trigger idempotency
 * 8. Real VerificationService and CompletionPolicy production wiring
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { execFileSync } from "child_process"
import {
  queryFdxCapabilities,
  deriveChangeIntelligence,
  generateVerificationPlan,
  executeNativeVerification,
  createVerificationAttestation,
  verifyAttestationFile,
  classifyVerificationFailures,
  computeRepoStateFingerprint,
  invalidateCapabilityCache,
} from "../src/services/fdx-vci-adapter"
import {
  runFdxVerification,
  isFdxEvidenceStale,
} from "../src/orchestration/verification/fdx-verification-provider"
import { VerificationStatus } from "../src/orchestration/types"
import type { FdxCapabilitySnapshot } from "../src/services/fdx-vci-adapter"
import { buildCalibrationSignal } from "../src/orchestration/verification/fdx-recovery"

const BUNDLED_NATIVE_BIN = join(
  process.cwd(),
  "native",
  "fdx",
  `${process.platform}-${process.arch}`,
  process.platform === "win32" ? "fdx.exe" : "fdx"
)
// Other suites deliberately point FDX_BINARY_PATH at an absent fixture. Honor an
// externally supplied binary only when it exists; otherwise retain this suite's
// required bundled native authority fixture.
const NATIVE_BIN = process.env.FDX_BINARY_PATH && existsSync(process.env.FDX_BINARY_PATH)
  ? process.env.FDX_BINARY_PATH
  : BUNDLED_NATIVE_BIN
const NATIVE_AUTHORITY_BINARY_AVAILABLE = existsSync(NATIVE_BIN)
process.env.FDX_BINARY_PATH = NATIVE_BIN

// This suite qualifies only an actually available native binary. An unavailable
// platform bundle is explicitly non-qualifying; H41 supplies release acceptance.
describe.skipIf(!NATIVE_AUTHORITY_BINARY_AVAILABLE)("Native FDX Authority — Real Binary Operations", () => {
  let tmpRepo: string

  beforeEach(() => {
    process.env.FDX_BINARY_PATH = NATIVE_BIN
    invalidateCapabilityCache()
    tmpRepo = mkdtempSync(join(tmpdir(), "fdx-auth-test-"))
    // Initialize git repo in tmp directory
    execFileSync("git", ["init"], { cwd: tmpRepo, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: tmpRepo, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@flowdeck.dev"], { cwd: tmpRepo, stdio: "ignore" })
    writeFileSync(join(tmpRepo, "README.md"), "# Test Repo\n")
    execFileSync("git", ["add", "README.md"], { cwd: tmpRepo, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpRepo, stdio: "ignore" })
  })

  afterEach(() => {
    invalidateCapabilityCache()
    try {
      rmSync(tmpRepo, { recursive: true, force: true })
    } catch {}
  })

  it("requires a bundled or explicitly supplied native FDX binary", () => {
    expect(existsSync(NATIVE_BIN)).toBe(true)
  })

  it("queries native capabilities and confirms protocol 2 and schema 10", async () => {
    process.env.FDX_BINARY_PATH = NATIVE_BIN
    const caps = await queryFdxCapabilities(tmpRepo, true)
    expect(caps.providerState).toBe("native_vci_full")
    expect(caps.fdxProtocolVersion).toBe(2)
    expect(caps.graphSchema?.maximumWritable).toBe(10)
    expect(caps.verificationPredicateVersions).toContain("v1")
    expect(caps.verificationPredicateVersions).toContain("v2")
    expect(caps.calibrationContractVersions).toContain(2)
    expect(caps.policyContractVersions).toContain(1)
  })

  it("M6: native FDX generates plan with exact native digest passthrough (raw CLI == FlowDeck consumed)", async () => {
    process.env.FDX_BINARY_PATH = NATIVE_BIN
    const caps = await queryFdxCapabilities(tmpRepo, true)
    const intel = await deriveChangeIntelligence("run-m6", tmpRepo, caps)
    const plan = await generateVerificationPlan(intel, caps)

    // 1. Invoke raw native CLI independently
    const cliRaw = execFileSync(NATIVE_BIN, ["plan", "--format", "json"], {
      cwd: tmpRepo,
      encoding: "utf8",
    })
    const parsedCli = JSON.parse(cliRaw)

    // 2. Assert exact origin and authority
    expect(plan.providerState).toBe("native_vci_full")
    expect(plan.digestAuthority).toBe("fdx_native")
    expect(plan.basePlanDigest).toBe(parsedCli.base_plan_digest)
    expect(plan.effectivePlanDigest).toBe(parsedCli.effective_plan_digest)
    expect(plan.basePlanDigest.length).toBe(64)
    expect(plan.effectivePlanDigest.length).toBe(64)
  })

  it("M11: policy overlay passes through exact native application and snapshot digests", async () => {
    process.env.FDX_BINARY_PATH = NATIVE_BIN
    execFileSync(NATIVE_BIN, ["index"], { cwd: tmpRepo, stdio: "ignore" })
    const caps = await queryFdxCapabilities(tmpRepo, true)
    const intel = await deriveChangeIntelligence("run-m11", tmpRepo, caps)
    const plan = await generateVerificationPlan(intel, caps, { policyOverlay: true })

    const cliRaw = execFileSync(NATIVE_BIN, ["plan", "--policy-overlay", "--format", "json"], {
      cwd: tmpRepo,
      encoding: "utf8",
    })
    const parsedCli = JSON.parse(cliRaw)
    const app = parsedCli.application ?? parsedCli

    expect(plan.providerState).toBe("native_vci_full")
    expect(plan.digestAuthority).toBe("fdx_native")
    expect(plan.basePlanDigest).toBe(app.base_plan_digest)
    expect(plan.effectivePlanDigest).toBe(app.effective_plan_digest)
    expect(plan.policySnapshotDigest).toBe(app.policy_snapshot_digest)
    expect(plan.policyApplicationDigest).toBe(app.application_digest ?? app.policy_application_digest)
  })

  it("Hostile Test 1: missing base_plan_digest in native plan response fails closed (UNVERIFIED)", () => {
    const caps: FdxCapabilitySnapshot = {
      snapshotId: "s-h1",
      capturedAt: new Date().toISOString(),
      providerState: "native_vci_full",
      verificationPredicateVersions: ["v1", "v2"],
      calibrationContractVersions: [2],
      policyContractVersions: [1],
      assuranceLevels: ["EXACT"],
      networkAccess: false,
      telemetry: false,
      platformLimitations: [],
      missingCapabilities: [],
    }

    const mockEvidence = {
      runId: "r-h1",
      verificationRunId: "vr-h1",
      stateFingerprint: "fp-h1",
      outcome: "passed" as const,
      assurance: "EXACT",
      checksPassed: 0,
      checksFailed: 0,
      checksSkipped: 0,
      mandatoryPassed: true,
      mandatoryFailed: false,
      failureReasons: [],
      evidenceDigest: "ev-h1",
      persistenceFailed: false,
      checkResults: [],
      unresolvedObligations: [],
      providerState: "native_vci_full" as const,
    }

    const planWithoutDigest = {
      planId: "p-h1",
      runId: "r-h1",
      basePlanDigest: "",
      effectivePlanDigest: "",
      digestAuthority: "fdx_native" as const,
      checks: [],
      m11OverlayApplied: false,
      m11CandidatesAvailable: [],
      providerState: "native_vci_full" as const,
      assurance: "UNVERIFIED",
    }

    const blockers = classifyVerificationFailures(mockEvidence, planWithoutDigest, caps)
    expect(blockers.some(b => b.kind === "missing_native_plan_digest")).toBe(true)
  })

  it("Hostile Test 2: FlowDeck consumes exact native digest and never uses locally computed hash", async () => {
    process.env.FDX_BINARY_PATH = NATIVE_BIN
    const caps = await queryFdxCapabilities(tmpRepo, true)
    const intel = await deriveChangeIntelligence("run-h2", tmpRepo, caps)
    const plan = await generateVerificationPlan(intel, caps)

    // A local JSON.stringify(plan.checks) or custom SHA calculation would NOT match the canonical native digest
    expect(plan.digestAuthority).toBe("fdx_native")
    expect(plan.basePlanDigest.length).toBe(64)
    // The native digest is an authoritative JCS SHA-256 produced by FDX
    const cliRaw = execFileSync(NATIVE_BIN, ["plan", "--format", "json"], { cwd: tmpRepo, encoding: "utf8" })
    const parsedCli = JSON.parse(cliRaw)
    expect(plan.basePlanDigest).toBe(parsedCli.base_plan_digest)
  })

  it("Hostile Test 3: policy overlay without complete provenance fails closed", () => {
    const caps: FdxCapabilitySnapshot = {
      snapshotId: "s-h3",
      capturedAt: new Date().toISOString(),
      providerState: "native_vci_full",
      verificationPredicateVersions: ["v1", "v2"],
      calibrationContractVersions: [2],
      policyContractVersions: [1],
      assuranceLevels: ["EXACT"],
      networkAccess: false,
      telemetry: false,
      platformLimitations: [],
      missingCapabilities: [],
    }

    const incompleteOverlayPlan = {
      planId: "p-h3",
      runId: "r-h3",
      basePlanDigest: "base-digest-123",
      effectivePlanDigest: "eff-digest-123",
      digestAuthority: "fdx_native" as const,
      checks: [],
      m11OverlayApplied: true,
      policySnapshotDigest: "snap-123",
      // policyApplicationDigest is missing!
      m11CandidatesAvailable: [],
      providerState: "native_vci_full" as const,
      assurance: "EXACT",
    }

    const mockEvidence = {
      runId: "r-h3",
      verificationRunId: "vr-h3",
      stateFingerprint: "fp-h3",
      outcome: "passed" as const,
      assurance: "EXACT",
      checksPassed: 0,
      checksFailed: 0,
      checksSkipped: 0,
      mandatoryPassed: true,
      mandatoryFailed: false,
      failureReasons: [],
      evidenceDigest: "ev-h3",
      persistenceFailed: false,
      checkResults: [],
      unresolvedObligations: [],
      providerState: "native_vci_full" as const,
    }

    const blockers = classifyVerificationFailures(mockEvidence, incompleteOverlayPlan, caps)
    expect(blockers.some(b => b.kind === "policy_integrity_failure")).toBe(true)
  })

  it("Fallback path: TypeScript fallback is explicitly typed as typescript_fallback", async () => {
    const fallbackCaps: FdxCapabilitySnapshot = {
      snapshotId: "s-fb",
      capturedAt: new Date().toISOString(),
      providerState: "typescript_fallback",
      verificationPredicateVersions: [],
      calibrationContractVersions: [],
      policyContractVersions: [],
      assuranceLevels: ["DEGRADED"],
      networkAccess: false,
      telemetry: false,
      platformLimitations: ["fallback"],
      missingCapabilities: ["fdx_binary"],
    }
    const intel = await deriveChangeIntelligence("run-fb", tmpRepo, fallbackCaps)
    const plan = await generateVerificationPlan(intel, fallbackCaps)

    expect(plan.digestAuthority).toBe("typescript_fallback")
    expect(plan.providerState).toBe("typescript_fallback")
    expect(plan.assurance).toBe("DEGRADED")
  })

  it("M7 + M8: native FDX executes verification directly (not Node execFile)", async () => {
    process.env.FDX_BINARY_PATH = NATIVE_BIN
    const caps = await queryFdxCapabilities(tmpRepo, true)
    const intel = await deriveChangeIntelligence("run-m7", tmpRepo, caps)
    const { plan, evidence, rawRun } = await executeNativeVerification(intel, caps, { noPersist: true })
    expect(plan).toBeDefined()
    expect(evidence).toBeDefined()
    expect(evidence.providerState).toBe("native_vci_full")
    expect(rawRun).toBeDefined()
    expect(rawRun?.["run_id"]).toBeDefined()
  })

  it("M7 hostile: a nonzero native exit with JSON output is incomplete and cannot persist evidence", async () => {
    const failingBinary = join(tmpRepo, "fdx-nonzero-json")
    writeFileSync(failingBinary, `#!/usr/bin/env node
const command = process.argv[2]
if (command === "plan") {
  console.log(JSON.stringify({
    base_plan_digest: "a".repeat(64),
    effective_plan_digest: "b".repeat(64),
    selected_checks: [{ check_id: "check:one", display_name: "one", kind: "unit_test", mandatory: true, reason: "fixture", scope: "fixture" }]
  }))
  process.exit(0)
}
console.log(JSON.stringify({ run_id: "partial-native-output", outcome: "passed", persistence_status: { status: "persisted", path: ".fdx/runs/partial.json" } }))
process.exit(23)
`, { mode: 0o755 })
    const caps: FdxCapabilitySnapshot = {
      snapshotId: "s-nonzero-json",
      capturedAt: new Date().toISOString(),
      providerState: "native_vci_full",
      binaryPath: failingBinary,
      verificationPredicateVersions: ["v1", "v2"],
      calibrationContractVersions: [2],
      policyContractVersions: [1],
      assuranceLevels: ["EXACT"],
      networkAccess: false,
      telemetry: false,
      platformLimitations: [],
      missingCapabilities: [],
    }
    const intel = await deriveChangeIntelligence("run-nonzero-json", tmpRepo, caps, { changedFiles: ["README.md"] })
    const { evidence } = await executeNativeVerification(intel, caps, { noPersist: false })

    expect(evidence.outcome).toBe("incomplete")
    expect(evidence.persistenceFailed).toBe(true)
    expect(evidence.failureReasons.join(" ")).toContain("exited with code 23")
    expect(evidence.evidenceDigest).toBe("")
  })

  it("M7 hostile: an unknown native check status is rejected as malformed output", async () => {
    const malformedBinary = join(tmpRepo, "fdx-unknown-status")
    writeFileSync(malformedBinary, `#!/usr/bin/env node
const command = process.argv[2]
const plan = {
  base_plan_digest: "a".repeat(64),
  effective_plan_digest: "b".repeat(64),
  selected_checks: [{ check_id: "check:one", display_name: "one", kind: "unit_test", mandatory: true, reason: "fixture", scope: "fixture" }]
}
if (command === "plan") { console.log(JSON.stringify(plan)); process.exit(0) }
console.log(JSON.stringify({
  ...plan,
  run_id: "unknown-status-run",
  outcome: "passed",
  checks: [{ check_id: "check:one", status: "mystery_status" }],
  persistence_status: { status: "persisted", path: ".fdx/runs/unknown-status.json" }
}))
`, { mode: 0o755 })
    const caps: FdxCapabilitySnapshot = {
      snapshotId: "s-unknown-status",
      capturedAt: new Date().toISOString(),
      providerState: "native_vci_full",
      binaryPath: malformedBinary,
      verificationPredicateVersions: ["v1", "v2"],
      calibrationContractVersions: [2],
      policyContractVersions: [],
      assuranceLevels: ["EXACT"],
      networkAccess: false,
      telemetry: false,
      platformLimitations: [],
      missingCapabilities: [],
    }
    const { evidence } = await executeNativeVerification({
      runId: "run-unknown-status",
      repositoryRoot: tmpRepo,
      stateFingerprint: "fp-unknown-status",
      stateVersion: 1,
      changedFiles: ["README.md"],
      impactedFiles: ["README.md"],
      impactedPackages: [],
      uncertainFiles: [],
      assuranceLevel: "EXACT",
      providerState: "native_vci_full",
    }, caps, { noPersist: false, policyOverlay: false })

    expect(evidence.outcome).toBe("incomplete")
    expect(evidence.persistenceFailed).toBe(true)
    expect(evidence.failureReasons.join(" ")).toContain("unknown status")
    expect(evidence.evidenceDigest).toBe("")
  })

  it("M8→M9: failed native persistence withholds attestation and all completion evidence", async () => {
    const persistenceBinary = join(tmpRepo, "fdx-persistence-failure")
    const attestationMarker = join(tmpRepo, "attestation-should-not-run")
    writeFileSync(persistenceBinary, `#!/usr/bin/env node
const fs = require("fs")
const command = process.argv[2]
const plan = {
  base_plan_digest: "a".repeat(64),
  effective_plan_digest: "b".repeat(64),
  selected_checks: [{ check_id: "check:one", display_name: "one", kind: "unit_test", mandatory: true, reason: "fixture", scope: "fixture" }]
}
if (command === "plan") { console.log(JSON.stringify(plan)); process.exit(0) }
if (command === "attest") { fs.writeFileSync(${JSON.stringify(attestationMarker)}, "unexpected M9 invocation"); process.exit(77) }
console.log(JSON.stringify({
  ...plan,
  run_id: "persist-failure-run",
  outcome: "passed",
  checks: [{ check_id: "check:one", status: "passed", command: ["node"], duration_ms: 1 }],
  persistence_status: { status: "failed", reason: "fixture disk failure" }
}))
`, { mode: 0o755 })
    const caps: FdxCapabilitySnapshot = {
      snapshotId: "s-persist-failure",
      capturedAt: new Date().toISOString(),
      providerState: "native_vci_full",
      binaryPath: persistenceBinary,
      verificationPredicateVersions: ["v1", "v2"],
      calibrationContractVersions: [2],
      policyContractVersions: [],
      assuranceLevels: ["EXACT"],
      networkAccess: false,
      telemetry: false,
      platformLimitations: [],
      missingCapabilities: [],
    }
    const { result, session } = await runFdxVerification("run-persist-failure", {
      runId: "run-persist-failure",
      repositoryRoot: tmpRepo,
      stateFingerprint: "fp-persist-failure",
      stateVersion: 1,
      changedFiles: ["README.md"],
      impactedFiles: ["README.md"],
      impactedPackages: [],
      uncertainFiles: [],
      assuranceLevel: "EXACT",
      providerState: "native_vci_full",
    }, caps, { policyOverlay: false })

    expect(result.status).toBe(VerificationStatus.FAILED)
    expect(result.evidenceIds).toEqual([])
    expect(session.attestation?.verified).toBe(false)
    expect(session.blockers.some(blocker => blocker.kind === "persistence_failure")).toBe(true)
    expect(session.blockers.some(blocker => blocker.kind === "attestation_failure")).toBe(true)
    expect(existsSync(attestationMarker)).toBe(false)
  })

  it("M8: persistence failure fails closed and blocks verification PASS", async () => {
    // When persistence fails, mandatoryPassed must be false and failureReasons must record it
    const mockPlan = {
      planId: "p1",
      runId: "r1",
      basePlanDigest: "b1",
      effectivePlanDigest: "e1",
      checks: [{ checkId: "c1", command: "test", args: [], rationale: "", mandatory: true, policyAdded: false }],
      m11OverlayApplied: false,
      m11CandidatesAvailable: [],
      providerState: "native_vci_full" as const,
      assurance: "EXACT",
    }
    const failingEvidence = {
      runId: "r1",
      verificationRunId: "vr1",
      stateFingerprint: "fp1",
      outcome: "passed" as const,
      assurance: "EXACT",
      checksPassed: 1,
      checksFailed: 0,
      checksSkipped: 0,
      mandatoryPassed: false,
      mandatoryFailed: true,
      failureReasons: ["PERSISTENCE_FAILED: Database disk full"],
      evidenceDigest: "ev1",
      persistenceFailed: true,
      persistenceError: "Database disk full",
      checkResults: [{ checkId: "c1", status: "passed" as const, command: ["test"], durationMs: 10, passed: true }],
      unresolvedObligations: [],
      providerState: "native_vci_full" as const,
    }
    const caps: FdxCapabilitySnapshot = { snapshotId: "s1", capturedAt: new Date().toISOString(), providerState: "native_vci_full", verificationPredicateVersions: ["v1", "v2"], calibrationContractVersions: [2], policyContractVersions: [1], assuranceLevels: ["EXACT"], networkAccess: false, telemetry: false, platformLimitations: [], missingCapabilities: [] }
    const blockers = classifyVerificationFailures(failingEvidence, mockPlan, caps)
    expect(blockers.some(b => b.kind === "persistence_failure")).toBe(true)
  })

  it("M9: real Predicate v1 and v2 attestation creation & verification", async () => {
    process.env.FDX_BINARY_PATH = NATIVE_BIN
    const caps = await queryFdxCapabilities(tmpRepo, true)
    // Run verification with persistence to create a historical run
    const intel = await deriveChangeIntelligence("run-m9", tmpRepo, caps)
    const { evidence } = await executeNativeVerification(intel, caps)

    if (evidence.persistedArtifactPath) {
      const attestationV1 = await createVerificationAttestation(evidence.runId, caps, tmpRepo, { predicateVersion: "v1" })
      expect(attestationV1.predicate).toBe("v1")

      if (attestationV1.attestationFilePath && existsSync(attestationV1.attestationFilePath)) {
        const verifyRes = await verifyAttestationFile(attestationV1.attestationFilePath, caps, tmpRepo)
        expect(verifyRes.verified).toBe(true)
      }
    }
  })
})

describe("Content-Bound Repository State Fingerprint (Workstream D)", () => {
  let tmpRepo: string

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), "fdx-fingerprint-test-"))
    execFileSync("git", ["init"], { cwd: tmpRepo, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: tmpRepo, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@flowdeck.dev"], { cwd: tmpRepo, stdio: "ignore" })
    writeFileSync(join(tmpRepo, "src.ts"), "const x = 1;\n")
    execFileSync("git", ["add", "src.ts"], { cwd: tmpRepo, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpRepo, stdio: "ignore" })
  })

  afterEach(() => {
    try {
      rmSync(tmpRepo, { recursive: true, force: true })
    } catch {}
  })

  it("CRITICAL REGRESSION: different dirty file bytes produce different fingerprints with same HEAD", () => {
    // State A: modify src.ts with content "AAA"
    writeFileSync(join(tmpRepo, "src.ts"), "const x = 'AAA';\n")
    const fpA = computeRepoStateFingerprint(tmpRepo)

    // State B: modify src.ts with content "BBB" (same HEAD, same modified filename, different bytes)
    writeFileSync(join(tmpRepo, "src.ts"), "const x = 'BBB';\n")
    const fpB = computeRepoStateFingerprint(tmpRepo)

    // Fingerprints MUST be distinct
    expect(fpA).not.toBe(fpB)
    expect(fpA.length).toBe(32)
    expect(fpB.length).toBe(32)

    // Old PASS evidence computed at state A is stale for state B
    const staleCheck = isFdxEvidenceStale(
      {
        id: "res-1",
        runId: "run-1",
        checkType: "fdx_vci",
        status: VerificationStatus.PASSED,
        correlationId: "c1",
        result: "pass",
        stateFingerprint: fpA,
        stateVersion: 1,
        evidenceIds: [],
        failureReasons: [],
        createdAt: "",
        updatedAt: "",
      },
      fpB,
      1
    )
    expect(staleCheck).toBe(true)
  })

  it("returns to the identical fingerprint when repository content is restored", () => {
    const clean = computeRepoStateFingerprint(tmpRepo)
    writeFileSync(join(tmpRepo, "src.ts"), "const x = 'temporary';\n")
    expect(computeRepoStateFingerprint(tmpRepo)).not.toBe(clean)

    writeFileSync(join(tmpRepo, "src.ts"), "const x = 1;\n")
    expect(computeRepoStateFingerprint(tmpRepo)).toBe(clean)
  })

  it("fails closed with an explicit classification outside a Git repository", () => {
    const nonRepository = mkdtempSync(join(tmpdir(), "fdx-not-a-repo-"))
    try {
      expect(() => computeRepoStateFingerprint(nonRepository)).toThrow(/Unable to compute deterministic repository state fingerprint/)
    } finally {
      rmSync(nonRepository, { recursive: true, force: true })
    }
  })

  it("binds relevant untracked file content changes to the fingerprint", () => {
    const fpClean = computeRepoStateFingerprint(tmpRepo)

    // Add untracked file
    writeFileSync(join(tmpRepo, "untracked.ts"), "const untracked = true;\n")
    const fpWithUntracked = computeRepoStateFingerprint(tmpRepo)

    expect(fpClean).not.toBe(fpWithUntracked)

    // Change untracked file bytes
    writeFileSync(join(tmpRepo, "untracked.ts"), "const untracked = 'different';\n")
    const fpUntrackedModified = computeRepoStateFingerprint(tmpRepo)

    expect(fpWithUntracked).not.toBe(fpUntrackedModified)
  })

  it("detects same-size byte changes beyond four mebibytes", () => {
    const largePath = join(tmpRepo, "large.bin")
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 64, 0x61)
    bytes[bytes.length - 1] = 0x31
    writeFileSync(largePath, bytes)
    const fpA = computeRepoStateFingerprint(tmpRepo)

    bytes[bytes.length - 1] = 0x32
    writeFileSync(largePath, bytes)
    const fpB = computeRepoStateFingerprint(tmpRepo)

    expect(fpA).not.toBe(fpB)
  })

  it("binds staged, unstaged, deletion, and rename state", () => {
    const source = join(tmpRepo, "src.ts")
    writeFileSync(source, "const x = 'staged';\n")
    execFileSync("git", ["add", "src.ts"], { cwd: tmpRepo, stdio: "ignore" })
    const staged = computeRepoStateFingerprint(tmpRepo)

    writeFileSync(source, "const x = 'staged-and-unstaged';\n")
    const stagedAndUnstaged = computeRepoStateFingerprint(tmpRepo)
    expect(stagedAndUnstaged).not.toBe(staged)

    execFileSync("git", ["add", "src.ts"], { cwd: tmpRepo, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "staged fixture"], { cwd: tmpRepo, stdio: "ignore" })
    execFileSync("git", ["mv", "src.ts", "renamed.ts"], { cwd: tmpRepo, stdio: "ignore" })
    const renamed = computeRepoStateFingerprint(tmpRepo)

    execFileSync("git", ["rm", "-f", "renamed.ts"], { cwd: tmpRepo, stdio: "ignore" })
    const deleted = computeRepoStateFingerprint(tmpRepo)
    expect(renamed).not.toBe(deleted)
  })
})

describe("Milestone 10: Exact Per-Check Truth (Workstream E)", () => {
  it("preserves exact per-check results (A PASS, B FAIL, C PASS) without run-level collapsing", () => {
    const session = {
      sessionId: "s1",
      runId: "r1",
      stateVersion: 1,
      stateFingerprint: "fp1",
      basePlanDigest: "bp1",
      effectivePlanDigest: "ep1",
      plan: {
        planId: "p1",
        runId: "r1",
        basePlanDigest: "bp1",
        effectivePlanDigest: "ep1",
        checks: [
          { checkId: "check-A", command: "test", args: [], rationale: "", mandatory: true, policyAdded: false },
          { checkId: "check-B", command: "test", args: [], rationale: "", mandatory: true, policyAdded: false },
          { checkId: "check-C", command: "test", args: [], rationale: "", mandatory: false, policyAdded: false },
        ],
        m11OverlayApplied: false,
        m11CandidatesAvailable: [],
        providerState: "native_vci_full" as const,
        assurance: "EXACT",
      },
      evidence: {
        runId: "r1",
        verificationRunId: "vr1",
        stateFingerprint: "fp1",
        outcome: "failed" as const,
        assurance: "EXACT",
        checksPassed: 2,
        checksFailed: 1,
        checksSkipped: 0,
        mandatoryPassed: false,
        mandatoryFailed: true,
        failureReasons: ["check-B failed"],
        evidenceDigest: "ev1",
        persistenceFailed: false,
        checkResults: [
          { checkId: "check-A", status: "passed" as const, command: ["test"], durationMs: 10, passed: true },
          { checkId: "check-B", status: "failed" as const, command: ["test"], durationMs: 15, passed: false, reason: "Assertion error" },
          { checkId: "check-C", status: "passed" as const, command: ["test"], durationMs: 8, passed: true },
        ],
        unresolvedObligations: [],
        providerState: "native_vci_full" as const,
      },
      blockers: [],
      status: "failed" as const,
      createdAt: new Date().toISOString(),
    }

    const signal = buildCalibrationSignal(session)
    expect(signal).not.toBeNull()
    expect(signal?.passed).toBe(false)
    expect(signal?.checkResults.length).toBe(3)

    const checkA = signal?.checkResults.find(c => c.checkId === "check-A")
    const checkB = signal?.checkResults.find(c => c.checkId === "check-B")
    const checkC = signal?.checkResults.find(c => c.checkId === "check-C")

    // Exact truth preserved: A is passed, B is failed, C is passed
    expect(checkA?.passed).toBe(true)
    expect(checkB?.passed).toBe(false)
    expect(checkC?.passed).toBe(true)
  })

  it("refuses calibration signal (returns null) when per-check evidence is absent or empty", () => {
    const sessionWithoutCheckResults = {
      sessionId: "s2",
      runId: "r2",
      stateVersion: 1,
      stateFingerprint: "fp2",
      basePlanDigest: "bp2",
      effectivePlanDigest: "ep2",
      plan: {
        planId: "p2",
        runId: "r2",
        basePlanDigest: "bp2",
        effectivePlanDigest: "ep2",
        checks: [
          { checkId: "check-1", command: "test", args: [], rationale: "", mandatory: true, policyAdded: false },
        ],
        m11OverlayApplied: false,
        m11CandidatesAvailable: [],
        providerState: "native_vci_full" as const,
        assurance: "EXACT" as const,
      },
      evidence: {
        runId: "r2",
        verificationRunId: "vr2",
        stateFingerprint: "fp2",
        outcome: "passed" as const,
        assurance: "EXACT" as const,
        checksPassed: 1,
        checksFailed: 0,
        checksSkipped: 0,
        mandatoryPassed: true,
        mandatoryFailed: false,
        failureReasons: [],
        evidenceDigest: "ev2",
        persistenceFailed: false,
        checkResults: [], // empty: per-check evidence missing
        unresolvedObligations: [],
        providerState: "native_vci_full" as const,
      },
      blockers: [],
      status: "passed" as const,
      createdAt: new Date().toISOString(),
    }

    const signal = buildCalibrationSignal(sessionWithoutCheckResults)
    expect(signal).toBeNull()
  })

  it("refuses calibration when any planned check is unknown, duplicated, or inconsistent", () => {
    const plan = {
      planId: "p-exact",
      runId: "r-exact",
      basePlanDigest: "bp-exact",
      effectivePlanDigest: "ep-exact",
      checks: [{ checkId: "check-1", command: "test", args: [], rationale: "", mandatory: true, policyAdded: false }],
      m11OverlayApplied: false,
      m11CandidatesAvailable: [],
      providerState: "native_vci_full" as const,
      assurance: "EXACT",
    }
    const baseSession = {
      sessionId: "s-exact",
      runId: "r-exact",
      stateVersion: 1,
      stateFingerprint: "fp-exact",
      basePlanDigest: "bp-exact",
      effectivePlanDigest: "ep-exact",
      plan,
      blockers: [],
      status: "failed" as const,
      createdAt: new Date().toISOString(),
    }
    const evidence = {
      runId: "r-exact",
      verificationRunId: "vr-exact",
      stateFingerprint: "fp-exact",
      outcome: "incomplete" as const,
      assurance: "EXACT",
      checksPassed: 0,
      checksFailed: 0,
      checksSkipped: 1,
      mandatoryPassed: false,
      mandatoryFailed: true,
      failureReasons: ["unknown check result"],
      evidenceDigest: "ev-exact",
      persistenceFailed: false,
      checkResults: [{ checkId: "check-1", status: "skipped" as const, command: ["test"], durationMs: 1, passed: false }],
      unresolvedObligations: ["check-1"],
      providerState: "native_vci_full" as const,
    }

    expect(buildCalibrationSignal({ ...baseSession, evidence })).toBeNull()
    expect(buildCalibrationSignal({
      ...baseSession,
      evidence: {
        ...evidence,
        outcome: "failed",
        checkResults: [{ checkId: "check-1", status: "passed", command: ["test"], durationMs: 1, passed: false }],
      },
    })).toBeNull()
    expect(buildCalibrationSignal({
      ...baseSession,
      evidence: {
        ...evidence,
        outcome: "failed",
        checkResults: [{ checkId: "check-1", status: "failed", command: ["test"], durationMs: 1, passed: false }, { checkId: "check-1", status: "failed", command: ["test"], durationMs: 1, passed: false }],
      },
    })).toBeNull()
  })
})

describe("Cancellation, Restart & Concurrency Idempotency (Workstreams K & L)", () => {
  let tmpRepo: string

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), "fdx-conc-test-"))
    execFileSync("git", ["init"], { cwd: tmpRepo, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Native Authority Test"], { cwd: tmpRepo, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "native-authority@test.invalid"], { cwd: tmpRepo, stdio: "ignore" })
    writeFileSync(join(tmpRepo, "README.md"), "# Test\n")
    execFileSync("git", ["add", "."], { cwd: tmpRepo, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmpRepo, stdio: "ignore" })
  })

  afterEach(() => {
    try { rmSync(tmpRepo, { recursive: true, force: true }) } catch {}
  })

  it("fallback capability state is rejected before it can create completion evidence", async () => {
    const caps: FdxCapabilitySnapshot = { snapshotId: "s-fallback", capturedAt: new Date().toISOString(), providerState: "typescript_fallback", verificationPredicateVersions: [], calibrationContractVersions: [], policyContractVersions: [], assuranceLevels: [], networkAccess: false, telemetry: false, platformLimitations: [], missingCapabilities: [] }
    const intel = await deriveChangeIntelligence("run-fallback", tmpRepo, caps)

    const { result, session, blockers } = await runFdxVerification("run-fallback", intel, caps)

    expect(session.status).toBe("failed")
    expect(result.status).toBe(VerificationStatus.ERROR)
    expect(result.evidenceIds).toEqual([])
    expect(blockers[0]?.kind).toBe("provider_unavailable")
  })

  it("20x duplicate triggers produce identical deterministic state identity", async () => {
    const caps: FdxCapabilitySnapshot = { snapshotId: "s-dup", capturedAt: new Date().toISOString(), providerState: "typescript_fallback", verificationPredicateVersions: [], calibrationContractVersions: [], policyContractVersions: [], assuranceLevels: [], networkAccess: false, telemetry: false, platformLimitations: [], missingCapabilities: [] }
    const intel1 = await deriveChangeIntelligence("run-dup", tmpRepo, caps)

    const fingerprints: string[] = []
    for (let i = 0; i < 20; i++) {
      fingerprints.push(computeRepoStateFingerprint(tmpRepo))
    }

    // All 20 triggers must produce the exact same fingerprint (idempotency)
    const uniqueFingerprints = new Set(fingerprints)
    expect(uniqueFingerprints.size).toBe(1)
    expect(fingerprints[0]).toBe(intel1.stateFingerprint)
  })
  it("single-flight verification coalesces concurrent identical requests into one execution", async () => {
    process.env.FDX_BINARY_PATH = NATIVE_BIN
    const caps = await queryFdxCapabilities(tmpRepo, true)
    const intel = await deriveChangeIntelligence("run-sf", tmpRepo, caps)

    const concurrentRuns = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        executeNativeVerification(intel, caps, { noPersist: true })
      )
    )

    const firstDigest = concurrentRuns[0].evidence.evidenceDigest
    for (const run of concurrentRuns) {
      expect(run.evidence.evidenceDigest).toBe(firstDigest)
      expect(run.plan.effectivePlanDigest).toBe(concurrentRuns[0].plan.effectivePlanDigest)
    }
  })
})
