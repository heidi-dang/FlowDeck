/**
 * FDX VCI Adapter
 *
 * Single integration boundary between Heidi/FlowDeck orchestration and the
 * FDX Verifiable Change Intelligence (VCI) M1–M12 runtime.
 *
 * Architecture rule: Heidi is the orchestrator and decision-maker.
 * FDX is the code-change intelligence and verification authority.
 * This adapter is the ONLY production path to FDX; it must not be bypassed.
 *
 * Provider state hierarchy:
 *   native_vci_full   — FDX binary present, all VCI capabilities confirmed
 *   native_vci_partial — FDX binary present but some capabilities missing
 *   typescript_fallback — FDX absent; TypeScript-only intelligence used
 *   unavailable       — No intelligence available; caller degrades gracefully
 */

import { execFile, execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { resolveFdxBinaryPath } from "../tools/fdx-shared"

// ─── Protocol constants (mirrors crates/fdx/src/protocol.rs) ────────────────

export const FDX_CAPABILITY_CONTRACT_VERSION = 1
export const FDX_PROTOCOL_VERSION = 1
export const FDX_GRAPH_SCHEMA_VERSION = 9
export const FDX_MINIMUM_READABLE_SCHEMA = 1

// ─── Provider state ──────────────────────────────────────────────────────────

export type FdxProviderState =
  | "native_vci_full"
  | "native_vci_partial"
  | "typescript_fallback"
  | "unavailable"

// ─── Capability snapshot ─────────────────────────────────────────────────────

export interface FdxGraphSchema {
  minimumReadable: number
  maximumWritable: number
  canRead: boolean
  canWrite: boolean
  canVerify: boolean
}

export interface FdxCapabilitySnapshot {
  /** Monotonic session-scoped ID, not persisted */
  snapshotId: string
  capturedAt: string
  providerState: FdxProviderState
  /** Only present when providerState includes "native" */
  capabilityContractVersion?: number
  fdxProtocolVersion?: number
  graphSchema?: FdxGraphSchema
  selectionPolicyVersion?: number
  verificationPredicateVersions: string[]
  calibrationContractVersions: number[]
  policyContractVersions: number[]
  assuranceLevels: string[]
  networkAccess: boolean
  telemetry: boolean
  platform?: string
  /** Human-readable limitations for this platform */
  platformLimitations: string[]
  /** Capabilities explicitly not available */
  missingCapabilities: string[]
  /** Binary path if native */
  binaryPath?: string
  /** Binary version string */
  binaryVersion?: string
}

// ─── Task classification ─────────────────────────────────────────────────────

export type TaskMutationClass =
  | "NO_REPO_MUTATION"
  | "SIMPLE_REPO_MUTATION"
  | "COMPLEX_REPO_MUTATION"
  | "HIGH_RISK_REPO_MUTATION"

// ─── Change intelligence ──────────────────────────────────────────────────────

export interface FdxChangeIntelligence {
  runId: string
  repositoryRoot: string
  stateFingerprint: string
  stateVersion: number
  baseSha?: string
  headSha?: string
  changedFiles: string[]
  impactedFiles: string[]
  impactedPackages: string[]
  uncertainFiles: string[]
  assuranceLevel: string
  providerState: FdxProviderState
}

// ─── Verification plan ───────────────────────────────────────────────────────

export interface FdxVerificationCheck {
  checkId: string
  command: string
  args: string[]
  workdir?: string
  rationale: string
  mandatory: boolean
  /** True if added by M11 policy overlay */
  policyAdded: boolean
  policyId?: string
}

export interface FdxVerificationPlan {
  planId: string
  runId: string
  basePlanDigest: string
  effectivePlanDigest: string
  policySnapshotDigest?: string
  checks: FdxVerificationCheck[]
  m11OverlayApplied: boolean
  m11CandidatesAvailable: string[]
  providerState: FdxProviderState
}

// ─── Runtime evidence ────────────────────────────────────────────────────────

export interface FdxRuntimeEvidence {
  runId: string
  verificationRunId: string
  stateFingerprint: string
  checksPassed: number
  checksFailed: number
  checksSkipped: number
  mandatoryPassed: boolean
  mandatoryFailed: boolean
  failureReasons: string[]
  evidenceDigest: string
  providerState: FdxProviderState
}

// ─── Attestation reference ───────────────────────────────────────────────────

export interface FdxAttestationReference {
  attestationId: string
  predicate: "v1" | "v2"
  /** v2 only: policy provenance */
  policyId?: string
  policySnapshotDigest?: string
  evidenceDigest: string
  runId: string
  verificationRunId: string
  createdAt: string
  providerState: FdxProviderState
}

// ─── Structured failure blockers ────────────────────────────────────────────

export type FdxFailureKind =
  | "check_failed"
  | "check_incomplete"
  | "provider_degraded"
  | "provider_unavailable"
  | "unresolved_obligation"
  | "stale_evidence"
  | "attestation_failure"
  | "policy_integrity_failure"
  | "corrupt_state"
  | "incompatible_capabilities"

export interface FdxVerificationBlocker {
  kind: FdxFailureKind
  checkId?: string
  command?: string
  message: string
  /** Suggested specialist domain for repair */
  suggestedSpecialist?: string
  /** True if Heidi may attempt direct repair without specialist */
  heidiCanRepairDirectly: boolean
  providerState: FdxProviderState
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

const CAPABILITIES_TIMEOUT_MS = 5_000
const QUERY_TIMEOUT_MS = 30_000

/** Singleton capability snapshot, refreshed per workspace init. */
let _capabilitySnapshot: FdxCapabilitySnapshot | null = null
let _snapshotWorkspace: string | null = null

function runFdxSync(binary: string, args: string[], timeoutMs = QUERY_TIMEOUT_MS): string | null {
  try {
    return execFileSync(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

function runFdxAsync(binary: string, args: string[], timeoutMs = QUERY_TIMEOUT_MS): Promise<string | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      resolve(null)
    }, timeoutMs)
    const child = execFile(binary, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => {
      clearTimeout(timer)
      resolve(err ? null : stdout)
    })
  })
}

function computeWorkspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(resolve(workspaceRoot)).digest("hex").slice(0, 32)
}

function buildDegradedSnapshot(providerState: FdxProviderState, reason: string): FdxCapabilitySnapshot {
  return {
    snapshotId: randomUUID(),
    capturedAt: new Date().toISOString(),
    providerState,
    verificationPredicateVersions: [],
    calibrationContractVersions: [],
    policyContractVersions: [],
    assuranceLevels: [],
    networkAccess: false,
    telemetry: false,
    platformLimitations: [reason],
    missingCapabilities: ["all"],
  }
}

/**
 * Query FDX capabilities and return a typed snapshot.
 *
 * This is the authoritative capability negotiation point. Heidi must call this
 * before invoking any VCI operation to determine the provider state.
 *
 * Never cached past the current workspace session init.
 */
export async function queryFdxCapabilities(workspaceRoot: string): Promise<FdxCapabilitySnapshot> {
  const wsKey = computeWorkspaceKey(workspaceRoot)

  // Return cached if same workspace
  if (_capabilitySnapshot && _snapshotWorkspace === wsKey) {
    return _capabilitySnapshot
  }

  const binary = resolveFdxBinaryPath()
  if (!binary) {
    const snap = buildDegradedSnapshot("typescript_fallback", "FDX native binary not found; using TypeScript fallback")
    _capabilitySnapshot = snap
    _snapshotWorkspace = wsKey
    return snap
  }

  const raw = await runFdxAsync(binary, ["capabilities", "--format", "json"], CAPABILITIES_TIMEOUT_MS)
  if (!raw) {
    const snap = buildDegradedSnapshot("typescript_fallback", "FDX capabilities query failed; using TypeScript fallback")
    _capabilitySnapshot = snap
    _snapshotWorkspace = wsKey
    return snap
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    const snap = buildDegradedSnapshot("typescript_fallback", "FDX capabilities response not valid JSON")
    _capabilitySnapshot = snap
    _snapshotWorkspace = wsKey
    return snap
  }

  // Validate capability contract version before trusting any fields
  const contractVersion = parsed["capability_contract_version"]
  if (contractVersion !== FDX_CAPABILITY_CONTRACT_VERSION) {
    const snap = buildDegradedSnapshot(
      "typescript_fallback",
      `FDX capability contract version ${String(contractVersion)} is not supported (expected ${FDX_CAPABILITY_CONTRACT_VERSION})`
    )
    _capabilitySnapshot = snap
    _snapshotWorkspace = wsKey
    return snap
  }

  const graphSchema = parsed["graph_schema"] as Record<string, unknown> | undefined
  const missingCapabilities: string[] = []

  // Validate graph schema compatibility
  if (!graphSchema || !graphSchema["can_read"] || !graphSchema["can_write"]) {
    missingCapabilities.push("graph_read_write")
  }
  if (graphSchema && (graphSchema["maximum_writable"] as number) < FDX_MINIMUM_READABLE_SCHEMA) {
    missingCapabilities.push("graph_schema_compat")
  }

  const predicates = (parsed["verification_predicate_versions"] as string[]) ?? []
  if (!predicates.includes("v1")) missingCapabilities.push("predicate_v1")

  const providerState: FdxProviderState =
    missingCapabilities.length === 0
      ? "native_vci_full"
      : "native_vci_partial"

  const snap: FdxCapabilitySnapshot = {
    snapshotId: randomUUID(),
    capturedAt: new Date().toISOString(),
    providerState,
    capabilityContractVersion: contractVersion as number,
    fdxProtocolVersion: parsed["fdx_protocol_version"] as number | undefined,
    graphSchema: graphSchema
      ? {
          minimumReadable: graphSchema["minimum_readable"] as number,
          maximumWritable: graphSchema["maximum_writable"] as number,
          canRead: graphSchema["can_read"] as boolean,
          canWrite: graphSchema["can_write"] as boolean,
          canVerify: graphSchema["can_verify"] as boolean,
        }
      : undefined,
    selectionPolicyVersion: parsed["selection_policy_version"] as number | undefined,
    verificationPredicateVersions: predicates,
    calibrationContractVersions: (parsed["calibration_contract_versions"] as number[]) ?? [],
    policyContractVersions: (parsed["policy_contract_versions"] as number[]) ?? [],
    assuranceLevels: (parsed["assurance_levels"] as string[]) ?? [],
    networkAccess: (parsed["network_access"] as boolean) ?? false,
    telemetry: (parsed["telemetry"] as boolean) ?? false,
    platform: parsed["platform"] as string | undefined,
    platformLimitations: (parsed["platform_limitations"] as string[]) ?? [],
    missingCapabilities,
    binaryPath: binary,
    binaryVersion: runFdxSync(binary, ["--version"], 2_000)?.trim(),
  }

  _capabilitySnapshot = snap
  _snapshotWorkspace = wsKey
  return snap
}

/** Invalidate the cached capability snapshot (e.g. after binary update). */
export function invalidateFdxCapabilitySnapshot(): void {
  _capabilitySnapshot = null
  _snapshotWorkspace = null
}

/**
 * Classify a task to determine whether and how deeply to invoke the FDX VCI workflow.
 *
 * This classification prevents unnecessary heavy orchestration for simple tasks.
 */
export function classifyTaskMutation(
  taskDescription: string,
  context: {
    hasFileChanges?: boolean
    changedFileCount?: number
    crossPackage?: boolean
    affectsPublicApi?: boolean
    affectsTests?: boolean
    affectsConfig?: boolean
  }
): TaskMutationClass {
  const desc = taskDescription.toLowerCase()

  // Non-code tasks: questions, information requests, status checks
  const nonCodePatterns = [
    /^(what|which|how|where|when|why|who|can you|tell me|show me|explain|list|find)\s/,
    /\?(\s.*)?$/,
    /(version|status|configuration|setting|option|help|documentation)/,
    /(read|view|show|display|check|inspect|examine)\s/,
    /^git\s+(log|status|diff|show)/,
  ]
  if (nonCodePatterns.some(p => p.test(desc)) && !context.hasFileChanges) {
    return "NO_REPO_MUTATION"
  }

  if (!context.hasFileChanges) {
    return "NO_REPO_MUTATION"
  }

  // High risk: public API changes, cross-package, many files
  if (
    context.affectsPublicApi ||
    context.crossPackage ||
    (context.changedFileCount ?? 0) > 10
  ) {
    return "HIGH_RISK_REPO_MUTATION"
  }

  // Complex: multiple concerns or affects tests
  if (
    (context.changedFileCount ?? 0) > 3 ||
    context.affectsTests ||
    context.affectsConfig
  ) {
    return "COMPLEX_REPO_MUTATION"
  }

  // Simple: small isolated change
  return "SIMPLE_REPO_MUTATION"
}

/**
 * Derive change intelligence from FDX for a repository mutation.
 *
 * Returns a typed intelligence result. Never returns raw stdout.
 * Falls back gracefully when native FDX is unavailable.
 */
export async function deriveChangeIntelligence(
  runId: string,
  repositoryRoot: string,
  capabilities: FdxCapabilitySnapshot,
  options: {
    baseSha?: string
    headSha?: string
    changedFiles?: string[]
  } = {}
): Promise<FdxChangeIntelligence> {
  const stateFingerprint = computeRepoStateFingerprint(repositoryRoot)
  const stateVersion = Date.now()

  if (capabilities.providerState === "typescript_fallback" || capabilities.providerState === "unavailable") {
    return {
      runId,
      repositoryRoot,
      stateFingerprint,
      stateVersion,
      baseSha: options.baseSha,
      headSha: options.headSha,
      changedFiles: options.changedFiles ?? [],
      impactedFiles: options.changedFiles ?? [],
      impactedPackages: [],
      uncertainFiles: options.changedFiles ?? [],
      assuranceLevel: "degraded",
      providerState: capabilities.providerState,
    }
  }

  const binary = capabilities.binaryPath!
  const args = ["impact", "--format", "json"]
  if (options.baseSha) args.push("--base", options.baseSha)
  if (options.headSha) args.push("--head", options.headSha)
  if (options.changedFiles?.length) {
    for (const f of options.changedFiles.slice(0, 50)) {
      args.push("--file", f)
    }
  }

  const raw = await runFdxAsync(binary, args)
  if (!raw) {
    return {
      runId,
      repositoryRoot,
      stateFingerprint,
      stateVersion,
      baseSha: options.baseSha,
      headSha: options.headSha,
      changedFiles: options.changedFiles ?? [],
      impactedFiles: options.changedFiles ?? [],
      impactedPackages: [],
      uncertainFiles: options.changedFiles ?? [],
      assuranceLevel: "degraded",
      providerState: "typescript_fallback",
    }
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      runId,
      repositoryRoot,
      stateFingerprint,
      stateVersion,
      baseSha: options.baseSha,
      headSha: options.headSha,
      changedFiles: (parsed["changed_files"] as string[]) ?? options.changedFiles ?? [],
      impactedFiles: (parsed["impacted_files"] as string[]) ?? [],
      impactedPackages: (parsed["impacted_packages"] as string[]) ?? [],
      uncertainFiles: (parsed["uncertain_files"] as string[]) ?? [],
      assuranceLevel: (parsed["assurance_level"] as string) ?? "degraded",
      providerState: capabilities.providerState,
    }
  } catch {
    return {
      runId,
      repositoryRoot,
      stateFingerprint,
      stateVersion,
      baseSha: options.baseSha,
      headSha: options.headSha,
      changedFiles: options.changedFiles ?? [],
      impactedFiles: options.changedFiles ?? [],
      impactedPackages: [],
      uncertainFiles: options.changedFiles ?? [],
      assuranceLevel: "degraded",
      providerState: "typescript_fallback",
    }
  }
}

/**
 * Generate an M6 base verification plan plus optional M11 policy overlay.
 *
 * The M11 overlay is ADD_CHECK only; it never removes or skips checks.
 * The effective plan digest binds the full check set including overlays.
 */
export async function generateVerificationPlan(
  changeIntelligence: FdxChangeIntelligence,
  capabilities: FdxCapabilitySnapshot
): Promise<FdxVerificationPlan> {
  const planId = randomUUID()
  const basePlanDigest = computeDigest(JSON.stringify({ impacted: changeIntelligence.impactedFiles }))

  // TypeScript fallback: minimal plan
  if (
    capabilities.providerState === "typescript_fallback" ||
    capabilities.providerState === "unavailable"
  ) {
    const checks = buildFallbackPlan(changeIntelligence)
    return {
      planId,
      runId: changeIntelligence.runId,
      basePlanDigest,
      effectivePlanDigest: computeDigest(JSON.stringify(checks.map(c => c.checkId))),
      checks,
      m11OverlayApplied: false,
      m11CandidatesAvailable: [],
      providerState: changeIntelligence.providerState,
    }
  }

  const binary = capabilities.binaryPath!
  const args = [
    "plan",
    "--run-id", changeIntelligence.runId,
    "--format", "json",
  ]
  if (changeIntelligence.baseSha) args.push("--base", changeIntelligence.baseSha)
  if (changeIntelligence.headSha) args.push("--head", changeIntelligence.headSha)

  const raw = await runFdxAsync(binary, args)
  if (!raw) {
    const checks = buildFallbackPlan(changeIntelligence)
    return {
      planId,
      runId: changeIntelligence.runId,
      basePlanDigest,
      effectivePlanDigest: computeDigest(JSON.stringify(checks.map(c => c.checkId))),
      checks,
      m11OverlayApplied: false,
      m11CandidatesAvailable: [],
      providerState: "typescript_fallback",
    }
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const baseChecks = parseChecks(parsed["checks"] as unknown[], false)
    const overlayChecks: FdxVerificationCheck[] = []
    let m11Applied = false
    let policyDigest: string | undefined

    // M11 overlay: ADD_CHECK only
    if (
      capabilities.policyContractVersions.length > 0 &&
      Array.isArray(parsed["policy_overlay"])
    ) {
      const overlay = parsed["policy_overlay"] as Record<string, unknown>[]
      for (const policy of overlay) {
        if (policy["action"] === "ADD_CHECK") {
          const check = parseSingleCheck(policy, true)
          if (check && !baseChecks.some(c => c.checkId === check.checkId)) {
            overlayChecks.push(check)
            m11Applied = true
          }
        }
        // IMPORTANT: NEVER process REMOVE_CHECK or SKIP_CHECK from policy
      }
      policyDigest = parsed["policy_snapshot_digest"] as string | undefined
    }

    const allChecks = [...baseChecks, ...overlayChecks]
    const effectivePlanDigest = computeDigest(JSON.stringify(allChecks.map(c => c.checkId)))

    return {
      planId,
      runId: changeIntelligence.runId,
      basePlanDigest,
      effectivePlanDigest,
      policySnapshotDigest: policyDigest,
      checks: allChecks,
      m11OverlayApplied: m11Applied,
      m11CandidatesAvailable: (parsed["candidate_policy_ids"] as string[]) ?? [],
      providerState: capabilities.providerState,
    }
  } catch {
    const checks = buildFallbackPlan(changeIntelligence)
    return {
      planId,
      runId: changeIntelligence.runId,
      basePlanDigest,
      effectivePlanDigest: computeDigest(JSON.stringify(checks.map(c => c.checkId))),
      checks,
      m11OverlayApplied: false,
      m11CandidatesAvailable: [],
      providerState: "typescript_fallback",
    }
  }
}

/**
 * Persist FDX runtime evidence (M8 contract).
 *
 * Called after verification execution. Returns structured evidence
 * that Heidi stores for CompletionPolicy evaluation.
 */
export async function persistRuntimeEvidence(
  plan: FdxVerificationPlan,
  checkResults: Array<{ checkId: string; passed: boolean; output?: string }>,
  capabilities: FdxCapabilitySnapshot
): Promise<FdxRuntimeEvidence> {
  const passed = checkResults.filter(r => r.passed).length
  const failed = checkResults.filter(r => !r.passed).length
  const mandatoryIds = new Set(plan.checks.filter(c => c.mandatory).map(c => c.checkId))
  const mandatoryFailedList = checkResults.filter(r => mandatoryIds.has(r.checkId) && !r.passed)

  const evidencePayload = {
    planId: plan.planId,
    effectivePlanDigest: plan.effectivePlanDigest,
    results: checkResults.map(r => ({ checkId: r.checkId, passed: r.passed })),
  }
  const evidenceDigest = computeDigest(JSON.stringify(evidencePayload))

  if (
    capabilities.providerState !== "typescript_fallback" &&
    capabilities.providerState !== "unavailable" &&
    capabilities.binaryPath
  ) {
    // Persist to FDX runtime store
    const binary = capabilities.binaryPath
    const payload = JSON.stringify({
      run_id: plan.runId,
      plan_id: plan.planId,
      effective_plan_digest: plan.effectivePlanDigest,
      results: checkResults.map(r => ({ check_id: r.checkId, passed: r.passed, output: r.output?.slice(0, 2000) })),
    })
    await runFdxAsync(binary, ["runtime", "ingest", "--json", payload]).catch(() => null)
  }

  return {
    runId: plan.runId,
    verificationRunId: randomUUID(),
    stateFingerprint: evidenceDigest,
    checksPassed: passed,
    checksFailed: failed,
    checksSkipped: plan.checks.length - passed - failed,
    mandatoryPassed: mandatoryPassedList(mandatoryIds, checkResults),
    mandatoryFailed: mandatoryFailedList.length > 0,
    failureReasons: mandatoryFailedList.map(r => `check ${r.checkId} failed`),
    evidenceDigest,
    providerState: capabilities.providerState,
  }
}

/**
 * Generate an attestation reference (M9 contract).
 *
 * Predicate v1: no policy overlay.
 * Predicate v2: policy overlay applied (requires M11 provenance).
 *
 * IMPORTANT: This is a reference only. We do not claim signing or non-repudiation.
 */
export async function generateAttestationReference(
  evidence: FdxRuntimeEvidence,
  plan: FdxVerificationPlan,
  capabilities: FdxCapabilitySnapshot
): Promise<FdxAttestationReference> {
  const predicate: "v1" | "v2" = plan.m11OverlayApplied ? "v2" : "v1"
  const attestationId = computeDigest(JSON.stringify({
    predicate,
    runId: evidence.runId,
    verificationRunId: evidence.verificationRunId,
    evidenceDigest: evidence.evidenceDigest,
    effectivePlanDigest: plan.effectivePlanDigest,
    policySnapshotDigest: plan.policySnapshotDigest,
  }))

  return {
    attestationId,
    predicate,
    policyId: plan.m11OverlayApplied ? plan.policySnapshotDigest : undefined,
    policySnapshotDigest: plan.policySnapshotDigest,
    evidenceDigest: evidence.evidenceDigest,
    runId: evidence.runId,
    verificationRunId: evidence.verificationRunId,
    createdAt: new Date().toISOString(),
    providerState: capabilities.providerState,
  }
}

/**
 * Classify a verification failure into structured Heidi blockers.
 *
 * This is the key signal that drives Heidi's repair and routing decisions.
 * Heidi receives typed blockers, not raw stdout strings.
 */
export function classifyVerificationFailures(
  evidence: FdxRuntimeEvidence,
  plan: FdxVerificationPlan,
  capabilities: FdxCapabilitySnapshot
): FdxVerificationBlocker[] {
  const blockers: FdxVerificationBlocker[] = []

  if (capabilities.providerState === "unavailable") {
    blockers.push({
      kind: "provider_unavailable",
      message: "FDX VCI provider is unavailable",
      heidiCanRepairDirectly: false,
      providerState: capabilities.providerState,
    })
    return blockers
  }

  if (capabilities.providerState === "typescript_fallback") {
    blockers.push({
      kind: "provider_degraded",
      message: "FDX is in TypeScript fallback mode; evidence assurance is reduced",
      heidiCanRepairDirectly: true,
      providerState: capabilities.providerState,
    })
  }

  for (const reason of evidence.failureReasons) {
    const check = plan.checks.find(c => reason.includes(c.checkId))
    if (check) {
      blockers.push({
        kind: "check_failed",
        checkId: check.checkId,
        command: check.command,
        message: reason,
        suggestedSpecialist: inferSpecialist(check),
        heidiCanRepairDirectly: isSimpleFailure(check),
        providerState: capabilities.providerState,
      })
    }
  }

  // Unresolved obligations (mandatory checks not attempted)
  const attemptedIds = new Set(evidence.failureReasons.map(r => plan.checks.find(c => r.includes(c.checkId))?.checkId).filter(Boolean))
  for (const check of plan.checks.filter(c => c.mandatory)) {
    if (!attemptedIds.has(check.checkId) && evidence.checksFailed > 0) {
      blockers.push({
        kind: "unresolved_obligation",
        checkId: check.checkId,
        message: `Mandatory check ${check.checkId} not resolved`,
        heidiCanRepairDirectly: false,
        providerState: capabilities.providerState,
      })
    }
  }

  return blockers
}

// ─── VCI status for diagnostics ──────────────────────────────────────────────

export interface FdxVciStatus {
  provider: FdxProviderState
  binaryVersion?: string
  capabilities: FdxCapabilitySnapshot | null
  graphSchemaVersion?: number
}

export function getVciStatus(): FdxVciStatus {
  return {
    provider: _capabilitySnapshot?.providerState ?? "unavailable",
    binaryVersion: _capabilitySnapshot?.binaryVersion,
    capabilities: _capabilitySnapshot,
    graphSchemaVersion: _capabilitySnapshot?.graphSchema?.maximumWritable,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeDigest(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 32)
}

function computeRepoStateFingerprint(repositoryRoot: string): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    }).trim()
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    })
    return computeDigest(head + status)
  } catch {
    return computeDigest(String(Date.now()))
  }
}

function buildFallbackPlan(intel: FdxChangeIntelligence): FdxVerificationCheck[] {
  const checks: FdxVerificationCheck[] = []
  const isTs = intel.impactedFiles.some(f => f.endsWith(".ts") || f.endsWith(".tsx"))
  const isRust = intel.impactedFiles.some(f => f.endsWith(".rs") || f.endsWith("Cargo.toml"))

  if (isTs) {
    checks.push({
      checkId: "fallback:typecheck",
      command: "bun",
      args: ["tsc", "--noEmit"],
      rationale: "TypeScript type correctness (fallback plan)",
      mandatory: true,
      policyAdded: false,
    })
    checks.push({
      checkId: "fallback:test",
      command: "bun",
      args: ["test"],
      rationale: "Test suite (fallback plan)",
      mandatory: true,
      policyAdded: false,
    })
  }

  if (isRust) {
    checks.push({
      checkId: "fallback:cargo-test",
      command: "cargo",
      args: ["test", "-p", "fdx"],
      rationale: "Rust test suite (fallback plan)",
      mandatory: true,
      policyAdded: false,
    })
  }

  return checks
}

function parseChecks(raw: unknown[], policyAdded: boolean): FdxVerificationCheck[] {
  if (!Array.isArray(raw)) return []
  return raw.map(item => parseSingleCheck(item as Record<string, unknown>, policyAdded)).filter(Boolean) as FdxVerificationCheck[]
}

function parseSingleCheck(item: Record<string, unknown>, policyAdded: boolean): FdxVerificationCheck | null {
  if (!item || typeof item["check_id"] !== "string") return null
  return {
    checkId: item["check_id"] as string,
    command: (item["command"] as string) ?? "unknown",
    args: (item["args"] as string[]) ?? [],
    workdir: item["workdir"] as string | undefined,
    rationale: (item["rationale"] as string) ?? "",
    mandatory: (item["mandatory"] as boolean) ?? true,
    policyAdded,
    policyId: item["policy_id"] as string | undefined,
  }
}

function mandatoryPassedList(
  mandatoryIds: Set<string>,
  results: Array<{ checkId: string; passed: boolean }>
): boolean {
  for (const id of mandatoryIds) {
    const result = results.find(r => r.checkId === id)
    if (!result || !result.passed) return false
  }
  return true
}

function inferSpecialist(check: FdxVerificationCheck): string | undefined {
  const cmd = check.command.toLowerCase()
  const args = check.args.join(" ").toLowerCase()
  if (cmd === "cargo" || args.includes("cargo")) return "rust"
  if (cmd === "tsc" || args.includes("tsc") || args.includes("typecheck")) return "typescript"
  if (cmd === "bun" && args.includes("test")) return "test"
  if (cmd === "oxlint" || args.includes("lint")) return "lint"
  if (args.includes("migration") || args.includes("sqlite")) return "persistence"
  return undefined
}

function isSimpleFailure(check: FdxVerificationCheck): boolean {
  // Simple lint or format failures can be repaired directly by Heidi
  const args = check.args.join(" ").toLowerCase()
  return args.includes("lint") || args.includes("format") || args.includes("fmt")
}