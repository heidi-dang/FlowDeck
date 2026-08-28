#!/usr/bin/env bun

/**
 * H41 — strict Heidi ↔ FDX native-authority qualification.
 *
 * This harness is intentionally separate from historical H37–H40 evidence. It accepts
 * only a release-profile FDX binary and only real native CLI/adapter/orchestration output.
 * It does not seed FDX storage, construct fallback evidence, or award points for an
 * unavailable native binary. Any unavailable, degraded, malformed, or failed scenario is
 * a non-acceptance result.
 */

import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const REPORT_PATH = join(ROOT, "reports", "heidi-fdx-native-authority-strict-h41.json")
const binaryPath = resolve(process.env.FDX_BINARY_PATH ?? join(ROOT, "target", "release", "fdx"))
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
const sourceStatus = execFileSync("git", ["status", "--porcelain=v1"], { cwd: ROOT, encoding: "utf8" }).trim()
const scenarios = []
let fixtureRoot = ""

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function parseJson(command, args, cwd) {
  return JSON.parse(execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
}

function record(id, title, operation) {
  const startedAt = performance.now()
  try {
    const detail = operation()
    const passed = detail?.passed === true
    scenarios.push({ id, title, passed, durationMs: Math.round(performance.now() - startedAt), detail: detail?.detail ?? null })
    return detail
  } catch (error) {
    scenarios.push({
      id,
      title,
      passed: false,
      durationMs: Math.round(performance.now() - startedAt),
      detail: { error: error instanceof Error ? error.message : String(error) },
    })
    return { passed: false }
  }
}

async function recordAsync(id, title, operation) {
  const startedAt = performance.now()
  try {
    const detail = await operation()
    const passed = detail?.passed === true
    scenarios.push({ id, title, passed, durationMs: Math.round(performance.now() - startedAt), detail: detail?.detail ?? null })
    return detail
  } catch (error) {
    scenarios.push({
      id,
      title,
      passed: false,
      durationMs: Math.round(performance.now() - startedAt),
      detail: { error: error instanceof Error ? error.message : String(error) },
    })
    return { passed: false }
  }
}

function createFixtureRepository() {
  fixtureRoot = join(tmpdir(), `fdx-h41-native-${randomUUID()}`)
  mkdirSync(fixtureRoot, { recursive: true })
  execFileSync("git", ["init"], { cwd: fixtureRoot, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "FDX H41 Qualification"], { cwd: fixtureRoot, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "fdx-h41@flowdeck.invalid"], { cwd: fixtureRoot, stdio: "ignore" })
  writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({
    name: "fdx-h41-native-qualification",
    version: "1.0.0",
    private: true,
    scripts: {
      lint: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(0)\"",
      typecheck: "node -e \"process.exit(0)\"",
    },
  }, null, 2))
  writeFileSync(join(fixtureRoot, "package-lock.json"), "{}\n")
  writeFileSync(join(fixtureRoot, "index.ts"), "export const value = 1\n")
  execFileSync("git", ["add", "."], { cwd: fixtureRoot, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "H41 native fixture baseline"], { cwd: fixtureRoot, stdio: "ignore" })
  writeFileSync(join(fixtureRoot, "index.ts"), "export const value = 2\n")
}

function exactCheckTruth(checkResults, planChecks) {
  if (!Array.isArray(checkResults) || checkResults.length === 0 || !Array.isArray(planChecks) || planChecks.length === 0) return false
  const expected = new Set(planChecks.map(check => check.checkId))
  const seen = new Set()
  return checkResults.every(check => {
    const exact = check.status === "passed" || check.status === "failed"
    const consistent = check.passed === (check.status === "passed")
    const uniqueAndPlanned = expected.has(check.checkId) && !seen.has(check.checkId)
    seen.add(check.checkId)
    return exact && consistent && uniqueAndPlanned
  }) && seen.size === expected.size
}

async function qualify() {
  const report = {
    harness: "H41",
    purpose: "Strict native-only Heidi–FDX authority qualification",
    acceptanceRule: "Every scenario must pass with a real release FDX binary. Fallback, simulation, seeded storage, skipped cases, and unavailable binaries are non-acceptance.",
    timestamp: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    source: { head: sourceHead, cleanBeforeRun: sourceStatus.length === 0, status: sourceStatus || "clean" },
    binary: { path: binaryPath, exists: existsSync(binaryPath), releaseProfilePath: /(^|[\\/])release([\\/]|$)/.test(binaryPath) },
    nativeContract: null,
    scenarios,
    passed: 0,
    failed: 0,
    score: 0,
    status: "NON_ACCEPTANCE",
  }

  try {
    const provenance = record("H41-01", "Release binary and clean-source provenance", () => {
      const passed = existsSync(binaryPath) && report.binary.releaseProfilePath && sourceStatus.length === 0
      if (existsSync(binaryPath)) {
        report.binary.sha256 = sha256File(binaryPath)
        report.binary.sizeBytes = statSync(binaryPath).size
        report.binary.version = execFileSync(binaryPath, ["--version"], { encoding: "utf8" }).trim()
      }
      return { passed, detail: { ...report.binary, sourceHead, cleanBeforeRun: sourceStatus.length === 0 } }
    })
    if (!provenance.passed) return report

    process.env.FDX_BINARY_PATH = binaryPath
    const rawCapabilities = record("H41-02", "Exact native protocol and schema contract", () => {
      const json = parseJson(binaryPath, ["capabilities", "--format", "json"], ROOT)
      report.nativeContract = json
      return {
        passed: json.fdx_protocol_version === 2 &&
          json.graph_schema?.maximum_writable === 10 &&
          json.graph_schema?.minimum_readable === 1 &&
          json.capability_contract_version === 1 &&
          json.calibration_contract_versions?.includes(2) &&
          json.policy_contract_versions?.includes(1) &&
          json.verification_predicate_versions?.includes("v1") &&
          json.verification_predicate_versions?.includes("v2") &&
          json.network_access === false && json.telemetry === false,
        detail: json,
      }
    })
    if (!rawCapabilities.passed) return report

    createFixtureRepository()
    const adapter = await import("../src/services/fdx-vci-adapter.ts")
    const provider = await import("../src/orchestration/verification/fdx-verification-provider.ts")
    const recovery = await import("../src/orchestration/verification/fdx-recovery.ts")
    adapter.invalidateFdxCapabilitySnapshot()

    const capsResult = await recordAsync("H41-03", "Native capability negotiation without fallback", async () => {
      const caps = await adapter.queryFdxCapabilities(fixtureRoot, true)
      globalThis.__h41Caps = caps
      return { passed: caps.providerState === "native_vci_full" && caps.binaryPath === binaryPath, detail: caps }
    })
    if (!capsResult.passed) return report

    const intelligenceResult = await recordAsync("H41-04", "M1–M5 native change intelligence", async () => {
      const intelligence = await adapter.deriveChangeIntelligence("h41-intelligence", fixtureRoot, globalThis.__h41Caps)
      globalThis.__h41Intelligence = intelligence
      return {
        passed: intelligence.providerState === "native_vci_full" && intelligence.changedFiles.includes("index.ts") && intelligence.stateFingerprint.length === 32,
        detail: { providerState: intelligence.providerState, changedFiles: intelligence.changedFiles, stateFingerprint: intelligence.stateFingerprint },
      }
    })
    if (!intelligenceResult.passed) return report

    const planResult = await recordAsync("H41-05", "M6 native plan with FDX-owned digests", async () => {
      const plan = await adapter.generateVerificationPlan(globalThis.__h41Intelligence, globalThis.__h41Caps, { policyOverlay: false })
      globalThis.__h41Plan = plan
      return {
        passed: plan.providerState === "native_vci_full" && plan.digestAuthority === "fdx_native" && /^[a-f0-9]{64}$/.test(plan.basePlanDigest) && /^[a-f0-9]{64}$/.test(plan.effectivePlanDigest) && plan.checks.length > 0,
        detail: { basePlanDigest: plan.basePlanDigest, effectivePlanDigest: plan.effectivePlanDigest, checks: plan.checks.map(check => check.checkId) },
      }
    })
    if (!planResult.passed) return report

    const executionResult = await recordAsync("H41-06", "M7 execution and M8 durable native artifact", async () => {
      const execution = await adapter.executeNativeVerification(globalThis.__h41Intelligence, globalThis.__h41Caps, { policyOverlay: false })
      globalThis.__h41Execution = execution
      const evidence = execution.evidence
      const artifactDigest = evidence.persistedArtifactPath && existsSync(evidence.persistedArtifactPath) ? sha256File(evidence.persistedArtifactPath) : ""
      return {
        passed: execution.plan.digestAuthority === "fdx_native" && evidence.providerState === "native_vci_full" && evidence.outcome === "passed" && evidence.mandatoryPassed && !evidence.persistenceFailed && artifactDigest === evidence.evidenceDigest && exactCheckTruth(evidence.checkResults, execution.plan.checks),
        detail: { verificationRunId: evidence.verificationRunId, outcome: evidence.outcome, persistedArtifactPath: evidence.persistedArtifactPath, evidenceDigest: evidence.evidenceDigest, checkStatuses: evidence.checkResults.map(check => ({ checkId: check.checkId, status: check.status })) },
      }
    })
    if (!executionResult.passed) return report

    const attestationResult = await recordAsync("H41-07", "M9 real v1 attestation and file verification", async () => {
      const evidence = globalThis.__h41Execution.evidence
      const attestation = await adapter.createVerificationAttestation(evidence.verificationRunId, globalThis.__h41Caps, fixtureRoot, { predicateVersion: "v1" })
      const verification = attestation.attestationFilePath ? await adapter.verifyAttestationFile(attestation.attestationFilePath, globalThis.__h41Caps, fixtureRoot) : { verified: false }
      return {
        passed: attestation.verified && verification.verified && attestation.predicate === "v1" && /^[a-f0-9]{64}$/.test(attestation.evidenceDigest),
        detail: { attestationId: attestation.attestationId, predicate: attestation.predicate, attestationFilePath: attestation.attestationFilePath, verified: attestation.verified, verifierResult: verification.verified },
      }
    })
    if (!attestationResult.passed) return report

    const m10Result = await recordAsync("H41-08", "M10 exact native calibration with no synthesized check state", async () => {
      const execution = globalThis.__h41Execution
      const signal = recovery.buildCalibrationSignal({
        sessionId: "h41-m10",
        runId: execution.plan.runId,
        stateVersion: globalThis.__h41Intelligence.stateVersion,
        stateFingerprint: globalThis.__h41Intelligence.stateFingerprint,
        basePlanDigest: execution.plan.basePlanDigest,
        effectivePlanDigest: execution.plan.effectivePlanDigest,
        plan: execution.plan,
        evidence: execution.evidence,
        blockers: [],
        status: "passed",
        createdAt: new Date().toISOString(),
      })
      const calibration = parseJson(binaryPath, ["calibrate", "run", "--run", execution.evidence.verificationRunId, "--format", "json"], fixtureRoot)
      return {
        passed: signal !== null && exactCheckTruth(signal.checkResults, execution.plan.checks) && calibration.status === "complete" && calibration.source_run_id === execution.evidence.verificationRunId && calibration.calibration_contract_version === 2,
        detail: { calibrationId: calibration.calibration_id, sourceRunId: calibration.source_run_id, status: calibration.status, checkCount: signal?.checkResults.length ?? 0 },
      }
    })
    if (!m10Result.passed) return report

    const m11Result = record("H41-09", "M11 native candidate evaluation remains separate from frozen M10", () => {
      const candidates = parseJson(binaryPath, ["policy", "generate-candidates", "--format", "json"], fixtureRoot)
      const active = parseJson(binaryPath, ["policy", "list-active", "--format", "json"], fixtureRoot)
      const candidateList = Array.isArray(candidates) ? candidates : candidates.candidates
      const activeList = Array.isArray(active) ? active : active.policies
      return {
        passed: Array.isArray(candidateList) && Array.isArray(activeList) && activeList.length === 0,
        detail: { candidateCount: candidateList?.length ?? null, activePolicyCount: activeList?.length ?? null, note: "No candidate was eligible in the real one-run fixture; absence of promotion is the expected native policy result." },
      }
    })
    if (!m11Result.passed) return report

    const providerResult = await recordAsync("H41-10", "Production provider completion requires native M7/M8/M9 evidence", async () => {
      const intelligence = await adapter.deriveChangeIntelligence("h41-provider", fixtureRoot, globalThis.__h41Caps)
      const outcome = await provider.runFdxVerification("h41-provider", intelligence, globalThis.__h41Caps)
      return {
        passed: outcome.result.status === "passed" && outcome.session.attestation?.verified === true && outcome.result.evidenceIds.length >= 2,
        detail: { status: outcome.result.status, evidenceIds: outcome.result.evidenceIds, attestationVerified: outcome.session.attestation?.verified ?? false },
      }
    })
    if (!providerResult.passed) return report

    record("H41-11", "Repository mutation stales previously issued evidence", () => {
      const before = globalThis.__h41Intelligence.stateFingerprint
      writeFileSync(join(fixtureRoot, "index.ts"), "export const value = 3\n")
      const after = adapter.computeRepoStateFingerprint(fixtureRoot)
      return { passed: before !== after, detail: { before, after } }
    })
  } finally {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    report.passed = scenarios.filter(scenario => scenario.passed).length
    report.failed = scenarios.length - report.passed
    report.score = scenarios.length === 0 ? 0 : Number((10 * report.passed / scenarios.length).toFixed(2))
    report.status = report.failed === 0 && report.passed > 0 ? "ACCEPTED" : "NON_ACCEPTANCE"
    mkdirSync(resolve(REPORT_PATH, ".."), { recursive: true })
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n")
  }
  return report
}

const report = await qualify()
console.log(JSON.stringify({ harness: report.harness, status: report.status, passed: report.passed, failed: report.failed, score: report.score, report: REPORT_PATH }, null, 2))
process.exitCode = report.status === "ACCEPTED" ? 0 : 1
