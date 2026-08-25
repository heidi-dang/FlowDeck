/**
 * FDX VCI Adapter
 *
 * Single integration boundary between Heidi/FlowDeck orchestration and the
 * FDX Verifiable Change Intelligence (VCI) M1–M12 runtime.
 *
 * Architecture rules:
 *   1. Heidi is the orchestrator and decision-maker.
 *   2. FDX is the code-change intelligence and verification authority.
 *   3. This adapter is the ONLY production path to FDX; it must not be bypassed.
 *   4. Native FDX executes verification directly (M7); Node does not parse and run commands.
 *   5. Fallback execution is explicitly typed as "typescript_fallback" and never native.
 *
 * Provider state hierarchy:
 *   native_vci_full     — FDX binary present, all required VCI capabilities confirmed
 *   native_vci_partial  — FDX binary present but some optional capabilities missing
 *   typescript_fallback — FDX absent; TypeScript-only intelligence used
 *   unavailable         — No intelligence available; caller degrades gracefully
 *   incompatible        — FDX binary has incompatible protocol/contract version; fail closed
 */

import { execFile, execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { resolveFdxBinaryPath, invalidateFdxCache } from "../tools/fdx-shared"
import {
  FDX_PROTOCOL_VERSION,
  FDX_GRAPH_SCHEMA_VERSION,
  FDX_GRAPH_SCHEMA_MIN_READABLE,
  FDX_CAPABILITY_CONTRACT_VERSION,
  FDX_CALIBRATION_CONTRACT_VERSION,
  FDX_POLICY_CONTRACT_VERSION,
  FDX_SELECTION_POLICY_VERSION,
  FDX_PREDICATE_VERSIONS,
  FDX_NETWORK_ACCESS,
  FDX_TELEMETRY,
  evaluateCapabilities,
  fdxCapabilitiesArgs,
  fdxPlanArgs,
  fdxVerifyArgs,
  fdxAttestCreateArgs,
  fdxAttestVerifyArgs,
  type CapabilityEvaluationResult,
} from "./fdx-vci-contracts"

// Re-export canonical constants for backward compatibility
export {
  FDX_PROTOCOL_VERSION,
  FDX_GRAPH_SCHEMA_VERSION,
  FDX_GRAPH_SCHEMA_MIN_READABLE,
  FDX_CAPABILITY_CONTRACT_VERSION,
  FDX_CALIBRATION_CONTRACT_VERSION,
  FDX_POLICY_CONTRACT_VERSION,
  FDX_SELECTION_POLICY_VERSION,
  FDX_PREDICATE_VERSIONS,
  FDX_NETWORK_ACCESS,
  FDX_TELEMETRY,
}

// ─── Provider state ──────────────────────────────────────────────────────────

export type FdxProviderState =
  | "native_vci_full"
  | "native_vci_partial"
  | "typescript_fallback"
  | "unavailable"
  | "incompatible"

// ─── Capability snapshot ─────────────────────────────────────────────────────

export interface FdxGraphSchema {
  minimumReadable: number
  maximumWritable: number
  canRead: boolean
  canWrite: boolean
  canVerify: boolean
}

export interface FdxCapabilitySnapshot {
  snapshotId: string
  capturedAt: string
  providerState: FdxProviderState
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
  platformLimitations: string[]
  missingCapabilities: string[]
  binaryPath?: string
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
  displayName?: string
  command: string
  args: string[]
  workdir?: string
  rationale: string
  mandatory: boolean
  kind?: string
  policyAdded: boolean
  policyId?: string
}

export type FdxDigestAuthority = "fdx_native" | "typescript_fallback"

export interface FdxVerificationPlan {
  planId: string
  runId: string
  basePlanDigest: string
  effectivePlanDigest: string
  policySnapshotDigest?: string
  policyApplicationDigest?: string
  digestAuthority?: FdxDigestAuthority
  checks: FdxVerificationCheck[]
  m11OverlayApplied: boolean
  m11CandidatesAvailable: string[]
  providerState: FdxProviderState
  assurance: string
}

// ─── Check execution result (Milestone 7) ───────────────────────────────────

export interface FdxCheckExecutionResult {
  checkId: string
  kind?: string
  status: "passed" | "failed" | "timed_out" | "output_limit_exceeded" | "spawn_failed" | "unsupported" | "skipped" | "cancelled"
  executionId?: string
  reusedExecution?: boolean
  command: string[]
  cwd?: string
  exitCode?: number | null
  signal?: string | null
  durationMs: number
  stdoutDigest?: string | null
  stderrDigest?: string | null
  stdoutExcerpt?: string
  stderrExcerpt?: string
  outputTruncated?: boolean
  reason?: string | null
  passed: boolean
}

// ─── Runtime evidence (Milestone 8) ─────────────────────────────────────────

export interface FdxRuntimeEvidence {
  runId: string
  verificationRunId: string
  stateFingerprint: string
  outcome: "passed" | "failed" | "incomplete"
  assurance: string
  checksPassed: number
  checksFailed: number
  checksSkipped: number
  mandatoryPassed: boolean
  mandatoryFailed: boolean
  failureReasons: string[]
  evidenceDigest: string
  persistedArtifactPath?: string
  persistenceFailed: boolean
  persistenceError?: string
  checkResults: FdxCheckExecutionResult[]
  unresolvedObligations: string[]
  providerState: FdxProviderState
}

// ─── Attestation reference (Milestone 9) ────────────────────────────────────

export interface FdxAttestationReference {
  attestationId: string
  predicate: "v1" | "v2"
  attestationFilePath?: string
  artifactSha256?: string
  policyId?: string
  policySnapshotDigest?: string
  policyApplicationDigest?: string
  evidenceDigest: string
  runId: string
  verificationRunId: string
  createdAt: string
  verified: boolean
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
  | "persistence_failure"
  | "corrupt_state"
  | "incompatible_capabilities"
  | "missing_native_plan_digest"

export interface FdxVerificationBlocker {
  kind: FdxFailureKind
  checkId?: string
  command?: string
  message: string
  suggestedSpecialist?: string
  heidiCanRepairDirectly: boolean
  providerState: FdxProviderState
}

// ─── Adapter State ──────────────────────────────────────────────────────────

const CAPABILITIES_TIMEOUT_MS = 5_000
const QUERY_TIMEOUT_MS = 60_000
const VERIFY_TIMEOUT_MS = 180_000

let _capabilitySnapshot: FdxCapabilitySnapshot | null = null
let _snapshotWorkspace: string | null = null

function runFdxSync(binary: string, args: string[], timeoutMs = QUERY_TIMEOUT_MS, cwd?: string): string | null {
  try {
    return execFileSync(binary, args, {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

function runFdxAsync(
  binary: string,
  args: string[],
  timeoutMs = QUERY_TIMEOUT_MS,
  cwd?: string,
  signal?: AbortSignal
): Promise<{ stdout: string; exitCode: number | null; error?: Error }> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        try { child.kill("SIGKILL") } catch {}
        resolve({ stdout: "", exitCode: null, error: new Error("FDX execution timed out") })
      }
    }, timeoutMs)

    const child = execFile(
      binary,
      args,
      {
        encoding: "utf8",
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        signal,
      },
      (err, stdout, _stderr) => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          resolve({
            stdout: stdout ?? "",
            exitCode: err ? (child.exitCode ?? 1) : 0,
            error: err ?? undefined,
          })
        }
      }
    )

    if (signal) {
      signal.addEventListener("abort", () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          try { child.kill("SIGKILL") } catch {}
          resolve({ stdout: "", exitCode: null, error: new Error("FDX execution cancelled") })
        }
      }, { once: true })
    }
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

// ─── Capability Negotiation (M12) ────────────────────────────────────────────

export async function queryFdxCapabilities(
  workspaceRoot: string,
  forceRefresh = false,
  config: {
    policyOverlayEnabled?: boolean
    calibrationEnabled?: boolean
    requirePredicateV2?: boolean
  } = {}
): Promise<FdxCapabilitySnapshot> {
  const wsKey = computeWorkspaceKey(workspaceRoot)
  if (!forceRefresh && _capabilitySnapshot && _snapshotWorkspace === wsKey) {
    return _capabilitySnapshot
  }

  const binaryPath = resolveFdxBinaryPath(forceRefresh)

  if (!binaryPath) {
    _capabilitySnapshot = buildDegradedSnapshot(
      "typescript_fallback",
      "FDX native binary not found on system PATH or in native/ directories; TypeScript fallback active."
    )
    _snapshotWorkspace = wsKey
    return _capabilitySnapshot
  }

  let versionOutput: string | null = null
  try {
    versionOutput = execFileSync(binaryPath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CAPABILITIES_TIMEOUT_MS,
    }).trim()
  } catch {
    _capabilitySnapshot = buildDegradedSnapshot(
      "typescript_fallback",
      "FDX binary exists but failed --version check; TypeScript fallback active."
    )
    _snapshotWorkspace = wsKey
    return _capabilitySnapshot
  }

  let capJsonRaw: string | null = null
  try {
    capJsonRaw = execFileSync(binaryPath, fdxCapabilitiesArgs(), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CAPABILITIES_TIMEOUT_MS,
    })
  } catch {
    _capabilitySnapshot = buildDegradedSnapshot(
      "typescript_fallback",
      "FDX binary does not support 'capabilities' command; TypeScript fallback active."
    )
    _snapshotWorkspace = wsKey
    return _capabilitySnapshot
  }

  let rawCapObj: unknown = null
  try {
    rawCapObj = JSON.parse(capJsonRaw)
  } catch {
    _capabilitySnapshot = buildDegradedSnapshot(
      "unavailable",
      "FDX capabilities response could not be parsed as JSON."
    )
    _snapshotWorkspace = wsKey
    return _capabilitySnapshot
  }

  const evalResult: CapabilityEvaluationResult = evaluateCapabilities(rawCapObj, config)

  if (evalResult.providerState === "incompatible") {
    _capabilitySnapshot = {
      snapshotId: randomUUID(),
      capturedAt: new Date().toISOString(),
      providerState: "incompatible",
      verificationPredicateVersions: [],
      calibrationContractVersions: [],
      policyContractVersions: [],
      assuranceLevels: [],
      networkAccess: false,
      telemetry: false,
      platformLimitations: [evalResult.reason ?? "Incompatible FDX binary"],
      missingCapabilities: evalResult.missingCapabilities,
      binaryPath,
      binaryVersion: versionOutput ?? undefined,
    }
    _snapshotWorkspace = wsKey
    return _capabilitySnapshot
  }

  const p = evalResult.parsed!
  _capabilitySnapshot = {
    snapshotId: randomUUID(),
    capturedAt: new Date().toISOString(),
    providerState: evalResult.providerState,
    capabilityContractVersion: p.capabilityContractVersion,
    fdxProtocolVersion: p.fdxProtocolVersion,
    graphSchema: {
      minimumReadable: p.graphSchemaMinReadable,
      maximumWritable: p.graphSchemaMaxWritable,
      canRead: p.graphCanRead,
      canWrite: p.graphCanWrite,
      canVerify: p.graphCanVerify,
    },
    selectionPolicyVersion: p.selectionPolicyVersion,
    verificationPredicateVersions: p.verificationPredicateVersions,
    calibrationContractVersions: p.calibrationContractVersions,
    policyContractVersions: p.policyContractVersions,
    assuranceLevels: p.assuranceLevels,
    networkAccess: p.networkAccess,
    telemetry: p.telemetry,
    platform: p.platform,
    platformLimitations: p.platformLimitations,
    missingCapabilities: evalResult.missingCapabilities,
    binaryPath,
    binaryVersion: versionOutput ?? undefined,
  }
  _snapshotWorkspace = wsKey
  return _capabilitySnapshot
}

export function invalidateCapabilityCache(): void {
  _capabilitySnapshot = null
  _snapshotWorkspace = null
  invalidateFdxCache()
}

/** Backward-compatible alias for invalidateCapabilityCache */
export const invalidateFdxCapabilitySnapshot = invalidateCapabilityCache

// ─── Task Mutation Classification ────────────────────────────────────────────

const NON_CODE_EXTENSIONS = new Set([
  ".md", ".txt", ".rst", ".adoc",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
  ".csv", ".tsv",
  ".lock",
])

const HIGH_RISK_PATTERNS = [
  /[/]api[/]/,
  /[/]schema[/]/,
  /[/]protocol[/]/,
  /[/]contracts[/]/,
  /Cargo\.toml$/,
  /package\.json$/,
  /pnpm-lock\.yaml$/,
  /tsconfig.*\.json$/,
  /Dockerfile/,
  /[/]\.github[/]/,
  /[/]\.gitlab-ci\.yml/,
]

const READONLY_TASK_KEYWORDS = [
  "what is", "where is", "how do", "explain", "describe", "show me",
  "list", "find", "search", "read", "view", "help", "who is",
  "summarize", "outline", "inspect", "diff",
]

export interface ClassifyTaskOptions {
  hasFileChanges?: boolean
  changedFileCount?: number
  affectsTests?: boolean
  crossPackage?: boolean
  affectsPublicApi?: boolean
  touchedFiles?: string[]
}

export function classifyTaskMutation(
  taskDescription: string,
  filesOrOptions: string[] | ClassifyTaskOptions = []
): TaskMutationClass {
  const lower = taskDescription.toLowerCase()

  const isOptionsObj = !Array.isArray(filesOrOptions) && typeof filesOrOptions === "object"
  const touchedFiles: string[] = Array.isArray(filesOrOptions)
    ? filesOrOptions
    : (filesOrOptions.touchedFiles ?? [])
  const hasFileChanges = isOptionsObj ? (filesOrOptions.hasFileChanges ?? touchedFiles.length > 0) : touchedFiles.length > 0
  const changedFileCount = isOptionsObj ? (filesOrOptions.changedFileCount ?? touchedFiles.length) : touchedFiles.length
  const crossPackage = isOptionsObj ? (filesOrOptions.crossPackage ?? false) : false
  const affectsPublicApi = isOptionsObj ? (filesOrOptions.affectsPublicApi ?? false) : false

  if (crossPackage || affectsPublicApi) {
    return "HIGH_RISK_REPO_MUTATION"
  }

  const effectiveCount = changedFileCount > 0 ? changedFileCount : touchedFiles.length

  if (!hasFileChanges && touchedFiles.length === 0 && effectiveCount === 0) {
    const isExplicitMutation =
      lower.startsWith("fix") ||
      lower.startsWith("add") ||
      lower.startsWith("create") ||
      lower.startsWith("delete") ||
      lower.startsWith("refactor") ||
      lower.startsWith("update") ||
      lower.startsWith("implement") ||
      lower.startsWith("change") ||
      lower.startsWith("modify") ||
      lower.startsWith("write")

    if (!isExplicitMutation) {
      for (const kw of READONLY_TASK_KEYWORDS) {
        if (lower.startsWith(kw) || lower.includes(" " + kw)) {
          return "NO_REPO_MUTATION"
        }
      }
    }
    return "NO_REPO_MUTATION"
  }

  if (effectiveCount === 0 && !hasFileChanges) {
    return "NO_REPO_MUTATION"
  }

  if (isOptionsObj && filesOrOptions.affectsTests && effectiveCount > 2) {
    return "COMPLEX_REPO_MUTATION"
  }

  if (touchedFiles.length > 0) {
    const allNonCode = touchedFiles.every(f => {
      const ext = f.slice(f.lastIndexOf(".")).toLowerCase()
      return NON_CODE_EXTENSIONS.has(ext)
    })

    if (allNonCode && touchedFiles.length <= 3) {
      return "SIMPLE_REPO_MUTATION"
    }

    for (const f of touchedFiles) {
      for (const pattern of HIGH_RISK_PATTERNS) {
        if (pattern.test(f)) {
          return "HIGH_RISK_REPO_MUTATION"
        }
      }
    }

    const packageRoots = new Set(
      touchedFiles.map(f => {
        const parts = f.split("/")
        return parts.length > 1 ? parts[0] : "root"
      })
    )
    if (packageRoots.size > 2) {
      return "HIGH_RISK_REPO_MUTATION"
    }
  }

  if (effectiveCount <= 2) {
    return "SIMPLE_REPO_MUTATION"
  }

  return "COMPLEX_REPO_MUTATION"
}

// ─── Change Intelligence ──────────────────────────────────────────────────────

export interface DeriveChangeIntelligenceOptions {
  runId?: string
  baseSha?: string
  headSha?: string
  changedFiles?: string[]
  stateVersion?: number
}

export async function deriveChangeIntelligence(
  runIdOrRoot: string,
  rootOrCaps: string | FdxCapabilitySnapshot,
  capsOrOpts?: FdxCapabilitySnapshot | DeriveChangeIntelligenceOptions,
  maybeOpts?: DeriveChangeIntelligenceOptions
): Promise<FdxChangeIntelligence> {
  let runId: string
  let repositoryRoot: string
  let capabilities: FdxCapabilitySnapshot
  let options: DeriveChangeIntelligenceOptions

  if (typeof rootOrCaps === "string") {
    // Called as: (runId, repositoryRoot, capabilities, options)
    runId = runIdOrRoot
    repositoryRoot = rootOrCaps
    capabilities = (capsOrOpts as FdxCapabilitySnapshot) ?? { providerState: "typescript_fallback" as FdxProviderState, verificationPredicateVersions: [], calibrationContractVersions: [], policyContractVersions: [], assuranceLevels: [], networkAccess: false, telemetry: false, platformLimitations: [], missingCapabilities: [] }
    options = maybeOpts ?? {}
  } else {
    // Called as: (repositoryRoot, capabilities, options)
    repositoryRoot = runIdOrRoot
    capabilities = rootOrCaps as FdxCapabilitySnapshot
    options = (capsOrOpts as DeriveChangeIntelligenceOptions) ?? {}
    runId = options.runId ?? randomUUID()
  }

  const stateVersion = options.stateVersion ?? 1
  const stateFingerprint = computeRepoStateFingerprint(repositoryRoot)

  if (
    capabilities.providerState === "typescript_fallback" ||
    capabilities.providerState === "unavailable" ||
    capabilities.providerState === "incompatible" ||
    !capabilities.binaryPath
  ) {
    const changed = options.changedFiles ?? []
    return {
      runId,
      repositoryRoot,
      stateFingerprint,
      stateVersion,
      baseSha: options.baseSha,
      headSha: options.headSha,
      changedFiles: changed,
      impactedFiles: changed,
      impactedPackages: [],
      uncertainFiles: changed,
      assuranceLevel: "degraded",
      providerState: "typescript_fallback",
    }
  }

  const binary = capabilities.binaryPath
  const baseCommit = options.baseSha ?? "HEAD"
  const args = ["diff", "--format", "json", baseCommit]

  let raw = runFdxSync(binary, args, QUERY_TIMEOUT_MS, repositoryRoot)
  // If baseCommit HEAD fails (e.g. initial empty repo), try without baseCommit
  if (!raw && options.baseSha) {
    raw = runFdxSync(binary, ["diff", "--format", "json"], QUERY_TIMEOUT_MS, repositoryRoot)
  }

  if (!raw) {
    const changed = options.changedFiles ?? []
    return {
      runId,
      repositoryRoot,
      stateFingerprint,
      stateVersion,
      baseSha: options.baseSha,
      headSha: options.headSha,
      changedFiles: changed,
      impactedFiles: changed,
      impactedPackages: [],
      uncertainFiles: changed,
      assuranceLevel: "degraded",
      providerState: "typescript_fallback",
    }
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    let changedFiles: string[] = []

    if (Array.isArray(parsed["files"])) {
      changedFiles = (parsed["files"] as Array<{ path?: string }>).map(f => f.path).filter(Boolean) as string[]
    } else if (Array.isArray(parsed["changed_files"])) {
      changedFiles = parsed["changed_files"] as string[]
    } else if (options.changedFiles) {
      changedFiles = options.changedFiles
    }

    return {
      runId,
      repositoryRoot,
      stateFingerprint,
      stateVersion,
      baseSha: (parsed["base"] as string) ?? (parsed["base_commit"] as string) ?? options.baseSha,
      headSha: (parsed["head_commit"] as string) ?? options.headSha,
      changedFiles,
      impactedFiles: changedFiles,
      impactedPackages: [],
      uncertainFiles: [],
      assuranceLevel: "exact",
      providerState: capabilities.providerState,
    }
  } catch {
    const changed = options.changedFiles ?? []
    return {
      runId,
      repositoryRoot,
      stateFingerprint,
      stateVersion,
      baseSha: options.baseSha,
      headSha: options.headSha,
      changedFiles: changed,
      impactedFiles: changed,
      impactedPackages: [],
      uncertainFiles: changed,
      assuranceLevel: "degraded",
      providerState: "typescript_fallback",
    }
  }
}

// ─── Verification Plan Generation (M6 + M11) ──────────────────────────────────

export async function generateVerificationPlan(
  changeIntelligence: FdxChangeIntelligence,
  capabilities: FdxCapabilitySnapshot,
  options: {
    policyOverlay?: boolean
  } = {}
): Promise<FdxVerificationPlan> {
  const planId = randomUUID()

  // TypeScript fallback path
  if (
    capabilities.providerState === "typescript_fallback" ||
    capabilities.providerState === "unavailable" ||
    capabilities.providerState === "incompatible" ||
    !capabilities.binaryPath
  ) {
    const checks = buildFallbackPlan(changeIntelligence)
    const basePlanDigest = computeDigest(JSON.stringify({ impacted: changeIntelligence.impactedFiles }))
    const effectivePlanDigest = computeDigest(JSON.stringify(checks.map(c => c.checkId)))
    return {
      planId,
      runId: changeIntelligence.runId,
      basePlanDigest,
      effectivePlanDigest,
      digestAuthority: "typescript_fallback",
      checks,
      m11OverlayApplied: false,
      m11CandidatesAvailable: [],
      providerState: "typescript_fallback",
      assurance: "DEGRADED",
    }
  }

  const binary = capabilities.binaryPath
  let planArgs = fdxPlanArgs({
    base: changeIntelligence.baseSha,
    head: changeIntelligence.headSha,
    policyOverlay: options.policyOverlay ?? (capabilities.policyContractVersions.length > 0),
  })

  let execRes = await runFdxAsync(binary, planArgs, QUERY_TIMEOUT_MS, changeIntelligence.repositoryRoot)

  // If failed with policy-overlay (e.g. unindexed repo), retry without policy overlay
  if ((execRes.exitCode !== 0 || !execRes.stdout) && planArgs.includes("--policy-overlay")) {
    planArgs = fdxPlanArgs({
      base: changeIntelligence.baseSha,
      head: changeIntelligence.headSha,
      policyOverlay: false,
    })
    execRes = await runFdxAsync(binary, planArgs, QUERY_TIMEOUT_MS, changeIntelligence.repositoryRoot)
  }

  const isNative = capabilities.providerState === "native_vci_full" || capabilities.providerState === "native_vci_partial"

  if (execRes.exitCode !== 0 || !execRes.stdout) {
    if (isNative) {
      return {
        planId,
        runId: changeIntelligence.runId,
        basePlanDigest: "",
        effectivePlanDigest: "",
        digestAuthority: "fdx_native",
        checks: [],
        m11OverlayApplied: false,
        m11CandidatesAvailable: [],
        providerState: capabilities.providerState,
        assurance: "UNVERIFIED",
      }
    }
    const checks = buildFallbackPlan(changeIntelligence)
    const basePlanDigest = computeDigest(JSON.stringify({ impacted: changeIntelligence.impactedFiles }))
    const effectivePlanDigest = computeDigest(JSON.stringify(checks.map(c => c.checkId)))
    return {
      planId,
      runId: changeIntelligence.runId,
      basePlanDigest,
      effectivePlanDigest,
      digestAuthority: "typescript_fallback",
      checks,
      m11OverlayApplied: false,
      m11CandidatesAvailable: [],
      providerState: "typescript_fallback",
      assurance: "DEGRADED",
    }
  }

  try {
    const parsed = JSON.parse(execRes.stdout) as Record<string, unknown>
    // Handle both M6 direct VerificationPlan and M11 EffectiveVerificationPlan
    const planObj = (parsed["plan"] as Record<string, unknown>) ?? parsed
    const application = parsed["application"] as Record<string, unknown> | undefined
    const selectedChecksRaw = (planObj["selected_checks"] as unknown[]) ?? (parsed["checks"] as unknown[]) ?? []

    const checks: FdxVerificationCheck[] = parsePlannedChecks(selectedChecksRaw)

    const basePlanDigest = typeof parsed["base_plan_digest"] === "string" && parsed["base_plan_digest"].length > 0
      ? (parsed["base_plan_digest"] as string)
      : typeof application?.["base_plan_digest"] === "string" && (application["base_plan_digest"] as string).length > 0
      ? (application["base_plan_digest"] as string)
      : typeof planObj["base_plan_digest"] === "string" && (planObj["base_plan_digest"] as string).length > 0
      ? (planObj["base_plan_digest"] as string)
      : ""

    const policySnapshotDigest = (typeof parsed["policy_snapshot_digest"] === "string" && parsed["policy_snapshot_digest"].length > 0 ? (parsed["policy_snapshot_digest"] as string) : undefined)
      ?? (typeof application?.["policy_snapshot_digest"] === "string" && (application["policy_snapshot_digest"] as string).length > 0 ? (application["policy_snapshot_digest"] as string) : undefined)
      ?? (typeof planObj["policy_snapshot_digest"] === "string" && (planObj["policy_snapshot_digest"] as string).length > 0 ? (planObj["policy_snapshot_digest"] as string) : undefined)

    const policyApplicationDigest = (typeof parsed["policy_application_digest"] === "string" && parsed["policy_application_digest"].length > 0 ? (parsed["policy_application_digest"] as string) : undefined)
      ?? (typeof parsed["application_digest"] === "string" && parsed["application_digest"].length > 0 ? (parsed["application_digest"] as string) : undefined)
      ?? (typeof application?.["policy_application_digest"] === "string" && (application["policy_application_digest"] as string).length > 0 ? (application["policy_application_digest"] as string) : undefined)
      ?? (typeof application?.["application_digest"] === "string" && (application["application_digest"] as string).length > 0 ? (application["application_digest"] as string) : undefined)
      ?? (typeof planObj["policy_application_digest"] === "string" && (planObj["policy_application_digest"] as string).length > 0 ? (planObj["policy_application_digest"] as string) : undefined)

    const effectivePlanDigest = typeof parsed["effective_plan_digest"] === "string" && parsed["effective_plan_digest"].length > 0
      ? (parsed["effective_plan_digest"] as string)
      : typeof application?.["effective_plan_digest"] === "string" && (application["effective_plan_digest"] as string).length > 0
      ? (application["effective_plan_digest"] as string)
      : typeof planObj["effective_plan_digest"] === "string" && (planObj["effective_plan_digest"] as string).length > 0
      ? (planObj["effective_plan_digest"] as string)
      : (!options.policyOverlay && !policyApplicationDigest && basePlanDigest ? basePlanDigest : "")

    const addedCheckIds = Array.isArray(parsed["added_check_ids"])
      ? (parsed["added_check_ids"] as string[])
      : Array.isArray(application?.["added_check_ids"])
      ? (application["added_check_ids"] as string[])
      : []

    const m11OverlayApplied = addedCheckIds.length > 0 || !!policyApplicationDigest

    if (isNative) {
      if (!basePlanDigest || !effectivePlanDigest) {
        return {
          planId,
          runId: changeIntelligence.runId,
          basePlanDigest: "",
          effectivePlanDigest: "",
          digestAuthority: "fdx_native",
          checks: [],
          m11OverlayApplied: false,
          m11CandidatesAvailable: [],
          providerState: capabilities.providerState,
          assurance: "UNVERIFIED",
        }
      }
      if (m11OverlayApplied && (!policySnapshotDigest || !policyApplicationDigest)) {
        return {
          planId,
          runId: changeIntelligence.runId,
          basePlanDigest: "",
          effectivePlanDigest: "",
          digestAuthority: "fdx_native",
          checks: [],
          m11OverlayApplied: false,
          m11CandidatesAvailable: [],
          providerState: capabilities.providerState,
          assurance: "UNVERIFIED",
        }
      }
    }

    return {
      planId,
      runId: changeIntelligence.runId,
      basePlanDigest,
      effectivePlanDigest,
      policySnapshotDigest,
      policyApplicationDigest,
      digestAuthority: isNative ? "fdx_native" : "typescript_fallback",
      checks,
      m11OverlayApplied,
      m11CandidatesAvailable: (parsed["candidate_policy_ids"] as string[]) ?? [],
      providerState: capabilities.providerState,
      assurance: String(planObj["assurance"] ?? parsed["assurance"] ?? "EXACT"),
    }
  } catch {
    if (isNative) {
      return {
        planId,
        runId: changeIntelligence.runId,
        basePlanDigest: "",
        effectivePlanDigest: "",
        digestAuthority: "fdx_native",
        checks: [],
        m11OverlayApplied: false,
        m11CandidatesAvailable: [],
        providerState: capabilities.providerState,
        assurance: "UNVERIFIED",
      }
    }
    const checks = buildFallbackPlan(changeIntelligence)
    const basePlanDigest = computeDigest(JSON.stringify({ impacted: changeIntelligence.impactedFiles }))
    const effectivePlanDigest = computeDigest(JSON.stringify(checks.map(c => c.checkId)))
    return {
      planId,
      runId: changeIntelligence.runId,
      basePlanDigest,
      effectivePlanDigest,
      digestAuthority: "typescript_fallback",
      checks,
      m11OverlayApplied: false,
      m11CandidatesAvailable: [],
      providerState: "typescript_fallback",
      assurance: "DEGRADED",
    }
  }
}

// ─── Native Verification Execution (M7) ──────────────────────────────────────

export interface ExecuteVerificationOptions {
  policyOverlay?: boolean
  failFast?: boolean
  noPersist?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  onProgress?: (msg: string) => void
}

const inFlightExecutions = new Map<string, Promise<{
  plan: FdxVerificationPlan
  evidence: FdxRuntimeEvidence
  rawRun?: Record<string, unknown>
}>>()

/**
 * Execute verification through native FDX (Milestone 7).
 *
 * In native mode, this invokes `fdx verify` directly. FDX owns:
 *   - Planning the check set
 *   - Executing the physical commands with process dedup
 *   - Persisting runtime evidence into .fdx/runs/ and .fdx/evidence.db (M8)
 *
 * Node does NOT parse commands and execute them individually in native mode.
 */
export async function executeNativeVerification(
  changeIntelligence: FdxChangeIntelligence,
  capabilities: FdxCapabilitySnapshot,
  options: ExecuteVerificationOptions = {}
): Promise<{
  plan: FdxVerificationPlan
  evidence: FdxRuntimeEvidence
  rawRun?: Record<string, unknown>
}> {
  const flightKey = `${changeIntelligence.repositoryRoot}:${changeIntelligence.stateFingerprint}:${options.policyOverlay ? "1" : "0"}:${options.failFast ? "1" : "0"}:${options.noPersist ? "1" : "0"}`

  if (!options.signal?.aborted && inFlightExecutions.has(flightKey)) {
    return inFlightExecutions.get(flightKey)!
  }

  const executionPromise = (async () => {
    const emit = options.onProgress ?? (() => undefined)

    // In fallback mode, execute fallback checks separately
    if (
      capabilities.providerState === "typescript_fallback" ||
      capabilities.providerState === "unavailable" ||
      capabilities.providerState === "incompatible" ||
      !capabilities.binaryPath
    ) {
      emit("[FDX Fallback] Executing TypeScript fallback verification...")
      const plan = await generateVerificationPlan(changeIntelligence, capabilities, {
        policyOverlay: options.policyOverlay,
      })
      const evidence = await executeFallbackVerification(plan, changeIntelligence.repositoryRoot, options.signal)
      return { plan, evidence }
    }

    const binary = capabilities.binaryPath
    const verifyArgs = fdxVerifyArgs({
      base: changeIntelligence.baseSha,
      head: changeIntelligence.headSha,
      policyOverlay: options.policyOverlay ?? (capabilities.policyContractVersions.length > 0),
      failFast: options.failFast,
      noPersist: options.noPersist,
    })

    emit("[FDX Native] Executing native FDX verification (Milestone 7)...")
    const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS
    const execRes = await runFdxAsync(
      binary,
      verifyArgs,
      timeoutMs,
      changeIntelligence.repositoryRoot,
      options.signal
    )

    if (options.signal?.aborted) {
      emit("[FDX Native] Verification cancelled by user.")
      const plan = await generateVerificationPlan(changeIntelligence, capabilities)
      const evidence: FdxRuntimeEvidence = {
        runId: changeIntelligence.runId,
        verificationRunId: randomUUID(),
        stateFingerprint: changeIntelligence.stateFingerprint,
        outcome: "incomplete",
        assurance: "UNVERIFIED",
        checksPassed: 0,
        checksFailed: 0,
        checksSkipped: plan.checks.length,
        mandatoryPassed: false,
        mandatoryFailed: false,
        failureReasons: ["CANCELLED: verification aborted by signal"],
        evidenceDigest: computeDigest("cancelled"),
        persistenceFailed: false,
        checkResults: [],
        unresolvedObligations: ["CANCELLED"],
        providerState: capabilities.providerState,
      }
      return { plan, evidence }
    }

    if (!execRes.stdout) {
      emit(`[FDX Native] Verification execution failed: ${execRes.error?.message ?? "empty output"}`)
      const plan = await generateVerificationPlan(changeIntelligence, capabilities)
      const evidence: FdxRuntimeEvidence = {
        runId: changeIntelligence.runId,
        verificationRunId: randomUUID(),
        stateFingerprint: changeIntelligence.stateFingerprint,
        outcome: "incomplete",
        assurance: "UNVERIFIED",
        checksPassed: 0,
        checksFailed: plan.checks.length,
        checksSkipped: 0,
        mandatoryPassed: false,
        mandatoryFailed: true,
        failureReasons: [`FDX execution error: ${execRes.error?.message ?? "native process failed"}`],
        evidenceDigest: computeDigest("exec_error"),
        persistenceFailed: true,
        persistenceError: "FDX process execution failed",
        checkResults: [],
        unresolvedObligations: plan.checks.map(c => c.checkId),
        providerState: capabilities.providerState,
      }
      return { plan, evidence }
    }

    try {
      const rawRun = JSON.parse(execRes.stdout) as Record<string, unknown>
      const planObj = (rawRun["plan"] as Record<string, unknown>) ?? {}
      const checksRaw = (planObj["selected_checks"] as unknown[]) ?? []
      const parsedChecks = parsePlannedChecks(checksRaw)

      const basePlanDigest = typeof rawRun["base_plan_digest"] === "string" && rawRun["base_plan_digest"].length > 0
        ? (rawRun["base_plan_digest"] as string)
        : typeof planObj["base_plan_digest"] === "string" && planObj["base_plan_digest"].length > 0
        ? (planObj["base_plan_digest"] as string)
        : ""

      const effectivePlanDigest = typeof rawRun["effective_plan_digest"] === "string" && rawRun["effective_plan_digest"].length > 0
        ? (rawRun["effective_plan_digest"] as string)
        : typeof planObj["effective_plan_digest"] === "string" && planObj["effective_plan_digest"].length > 0
        ? (planObj["effective_plan_digest"] as string)
        : (basePlanDigest && !options.policyOverlay ? basePlanDigest : "")

      const policySnapshotDigest = (typeof rawRun["policy_snapshot_digest"] === "string" && rawRun["policy_snapshot_digest"].length > 0 ? rawRun["policy_snapshot_digest"] as string : undefined)
        ?? (typeof planObj["policy_snapshot_digest"] === "string" && planObj["policy_snapshot_digest"].length > 0 ? planObj["policy_snapshot_digest"] as string : undefined)

      const policyApplicationDigest = (typeof rawRun["policy_application_digest"] === "string" && rawRun["policy_application_digest"].length > 0 ? rawRun["policy_application_digest"] as string : undefined)
        ?? (typeof rawRun["application_digest"] === "string" && rawRun["application_digest"].length > 0 ? rawRun["application_digest"] as string : undefined)
        ?? (typeof planObj["policy_application_digest"] === "string" && planObj["policy_application_digest"].length > 0 ? planObj["policy_application_digest"] as string : undefined)

      const addedCheckIds = Array.isArray(rawRun["added_check_ids"])
        ? (rawRun["added_check_ids"] as string[])
        : []
      const m11OverlayApplied = addedCheckIds.length > 0 || !!policyApplicationDigest

      const isNative = capabilities.providerState === "native_vci_full" || capabilities.providerState === "native_vci_partial"
      const missingNativeDigest = isNative && (!basePlanDigest || !effectivePlanDigest || (options.policyOverlay && (!policySnapshotDigest || !policyApplicationDigest)))

      if (missingNativeDigest) {
        const plan: FdxVerificationPlan = {
          planId: String(rawRun["run_id"] ?? randomUUID()),
          runId: String(rawRun["run_id"] ?? changeIntelligence.runId),
          basePlanDigest: "",
          effectivePlanDigest: "",
          digestAuthority: "fdx_native",
          checks: [],
          m11OverlayApplied: false,
          m11CandidatesAvailable: [],
          providerState: capabilities.providerState,
          assurance: "UNVERIFIED",
        }
        const evidence: FdxRuntimeEvidence = {
          runId: changeIntelligence.runId,
          verificationRunId: String(rawRun["run_id"] ?? randomUUID()),
          stateFingerprint: changeIntelligence.stateFingerprint,
          outcome: "incomplete",
          assurance: "UNVERIFIED",
          checksPassed: 0,
          checksFailed: parsedChecks.length,
          checksSkipped: 0,
          mandatoryPassed: false,
          mandatoryFailed: true,
          failureReasons: ["missing_native_plan_digest: FDX native plan digest or policy overlay provenance missing"],
          evidenceDigest: computeDigest("missing_native_digest"),
          persistenceFailed: true,
          persistenceError: "Missing native authoritative plan digest",
          checkResults: [],
          unresolvedObligations: ["missing_native_plan_digest"],
          providerState: capabilities.providerState,
        }
        return { plan, evidence, rawRun }
      }

      const plan: FdxVerificationPlan = {
        planId: String(rawRun["run_id"] ?? randomUUID()),
        runId: String(rawRun["run_id"] ?? changeIntelligence.runId),
        basePlanDigest,
        effectivePlanDigest,
        policySnapshotDigest,
        policyApplicationDigest,
        digestAuthority: isNative ? "fdx_native" : "typescript_fallback",
        checks: parsedChecks,
        m11OverlayApplied,
        m11CandidatesAvailable: (rawRun["candidate_policy_ids"] as string[]) ?? [],
        providerState: capabilities.providerState,
        assurance: String(rawRun["assurance"] ?? "EXACT"),
      }

      // Parse executed checks from VerificationRun.checks
      const executedChecksRaw = (rawRun["checks"] as Array<Record<string, unknown>>) ?? []
      const checkResults: FdxCheckExecutionResult[] = executedChecksRaw.map(c => {
        const status = String(c["status"] ?? "pending") as FdxCheckExecutionResult["status"]
        const passed = status === "passed"
        return {
          checkId: String(c["check_id"] ?? ""),
          kind: c["kind"] as string | undefined,
          status,
          executionId: c["execution_id"] as string | undefined,
          reusedExecution: c["reused_execution"] === true,
          command: Array.isArray(c["command"]) ? (c["command"] as string[]) : [],
          cwd: c["cwd"] as string | undefined,
          exitCode: typeof c["exit_code"] === "number" ? c["exit_code"] : null,
          signal: c["signal"] as string | null | undefined,
          durationMs: typeof c["duration_ms"] === "number" ? c["duration_ms"] : 0,
          stdoutDigest: c["stdout_digest"] as string | null | undefined,
          stderrDigest: c["stderr_digest"] as string | null | undefined,
          stdoutExcerpt: c["stdout_excerpt"] as string | undefined,
          stderrExcerpt: c["stderr_excerpt"] as string | undefined,
          outputTruncated: c["output_truncated"] === true,
          reason: c["reason"] as string | null | undefined,
          passed,
        }
      })

      const passedCount = checkResults.filter(c => c.passed).length
      const failedCount = checkResults.filter(c => !c.passed && c.status === "failed").length
      const skippedCount = checkResults.filter(c => c.status === "skipped").length

      const mandatoryIds = new Set(plan.checks.filter(c => c.mandatory).map(c => c.checkId))
      const mandatoryFailedList = checkResults.filter(c => mandatoryIds.has(c.checkId) && !c.passed)
      const mandatoryPassed = mandatoryIds.size === 0 || (mandatoryFailedList.length === 0 && passedCount >= mandatoryIds.size)

      // Check persistence status (M8 fail closed)
      const persistenceStatus = rawRun["persistence_status"] as Record<string, unknown> | undefined
      let persistenceFailed = persistenceStatus?.["status"] === "failed"
      let persistenceError = persistenceFailed ? String(persistenceStatus?.["reason"] ?? "M8 persistence failed") : undefined
      const persistedPath = persistenceStatus?.["status"] === "persisted" ? String(persistenceStatus["path"]) : undefined

      // Reopen and query exact persisted artifact bytes
      let evidenceDigest = ""
      if (persistedPath && existsSync(persistedPath)) {
        try {
          const rawBytes = readFileSync(persistedPath)
          evidenceDigest = createHash("sha256").update(rawBytes).digest("hex")
        } catch {
          evidenceDigest = ""
        }
      }

      if (capabilities.providerState === "native_vci_full" && !evidenceDigest && !options.noPersist) {
        persistenceFailed = true
        persistenceError = "M8 persisted artifact missing or unreadable on disk"
      }

      if (!evidenceDigest) {
        evidenceDigest = computeDigest(JSON.stringify(rawRun))
      }

      const outcome = (persistenceFailed ? "incomplete" : String(rawRun["outcome"] ?? (failedCount > 0 ? "failed" : "passed"))) as "passed" | "failed" | "incomplete"

      const failureReasons: string[] = []
      for (const c of checkResults) {
        if (!c.passed) {
          failureReasons.push(c.reason ? `${c.checkId}: ${c.reason}` : `check ${c.checkId} failed`)
        }
      }
      if (persistenceFailed) {
        failureReasons.push(`PERSISTENCE_FAILED: ${persistenceError ?? "M8 persistence failed"}`)
      }

      const evidence: FdxRuntimeEvidence = {
        runId: plan.runId,
        verificationRunId: String(rawRun["run_id"] ?? randomUUID()),
        stateFingerprint: changeIntelligence.stateFingerprint,
        outcome,
        assurance: String(rawRun["assurance"] ?? "EXACT"),
        checksPassed: passedCount,
        checksFailed: failedCount,
        checksSkipped: skippedCount,
        mandatoryPassed: !persistenceFailed && mandatoryPassed,
        mandatoryFailed: persistenceFailed || mandatoryFailedList.length > 0,
        failureReasons,
        evidenceDigest,
        persistedArtifactPath: persistedPath,
        persistenceFailed,
        persistenceError,
        checkResults,
        unresolvedObligations: Array.isArray(rawRun["unresolved_obligations"])
          ? (rawRun["unresolved_obligations"] as Array<Record<string, unknown>>).map(o => String(o["check_id"] ?? o["scope"] ?? "obligation"))
          : [],
        providerState: capabilities.providerState,
      }

      return { plan, evidence, rawRun }
    } catch (e: unknown) {
      emit(`[FDX Native] Failed to parse verification output: ${e instanceof Error ? e.message : String(e)}`)
      const plan = await generateVerificationPlan(changeIntelligence, capabilities)
      const evidence: FdxRuntimeEvidence = {
        runId: changeIntelligence.runId,
        verificationRunId: randomUUID(),
        stateFingerprint: changeIntelligence.stateFingerprint,
        outcome: "incomplete",
        assurance: "UNVERIFIED",
        checksPassed: 0,
        checksFailed: plan.checks.length,
        checksSkipped: 0,
        mandatoryPassed: false,
        mandatoryFailed: true,
        failureReasons: [`JSON parse error: ${e instanceof Error ? e.message : String(e)}`],
        evidenceDigest: computeDigest("parse_error"),
        persistenceFailed: true,
        persistenceError: "Could not parse VerificationRun output",
        checkResults: [],
        unresolvedObligations: plan.checks.map(c => c.checkId),
        providerState: capabilities.providerState,
      }
      return { plan, evidence }
    }
  })()

  inFlightExecutions.set(flightKey, executionPromise)
  try {
    return await executionPromise
  } finally {
    inFlightExecutions.delete(flightKey)
  }
}

// ─── TypeScript Fallback Verification Execution ──────────────────────────────

async function executeFallbackVerification(
  plan: FdxVerificationPlan,
  repositoryRoot: string,
  signal?: AbortSignal
): Promise<FdxRuntimeEvidence> {
  const checkResults: FdxCheckExecutionResult[] = []

  for (const check of plan.checks) {
    if (signal?.aborted) {
      checkResults.push({
        checkId: check.checkId,
        command: [check.command, ...check.args],
        status: "cancelled",
        durationMs: 0,
        passed: false,
        reason: "CANCELLED",
      })
      break
    }

    const start = Date.now()
    const result = await new Promise<{ passed: boolean; output: string; exitCode: number | null }>((resolvePromise) => {
      const child = execFile(
        check.command,
        check.args,
        {
          cwd: check.workdir ? resolve(repositoryRoot, check.workdir) : repositoryRoot,
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
          signal,
        },
        (err, stdout, stderr) => {
          resolvePromise({
            passed: !err,
            output: (stdout ?? "") + (stderr ?? ""),
            exitCode: err ? (child.exitCode ?? 1) : 0,
          })
        }
      )
    })

    const durationMs = Date.now() - start
    checkResults.push({
      checkId: check.checkId,
      command: [check.command, ...check.args],
      status: result.passed ? "passed" : "failed",
      exitCode: result.exitCode,
      durationMs,
      stdoutExcerpt: result.output.slice(0, 1000),
      passed: result.passed,
      reason: result.passed ? undefined : `Process exited with code ${result.exitCode}`,
    })
  }

  const passedCount = checkResults.filter(c => c.passed).length
  const failedCount = checkResults.filter(c => !c.passed).length
  const mandatoryIds = new Set(plan.checks.filter(c => c.mandatory).map(c => c.checkId))
  const mandatoryFailedList = checkResults.filter(c => mandatoryIds.has(c.checkId) && !c.passed)

  const evidenceDigest = computeDigest(JSON.stringify({
    runId: plan.runId,
    fallback: true,
    checkResults: checkResults.map(c => ({ id: c.checkId, passed: c.passed })),
  }))

  return {
    runId: plan.runId,
    verificationRunId: randomUUID(),
    stateFingerprint: computeRepoStateFingerprint(repositoryRoot),
    outcome: failedCount > 0 ? "failed" : "passed",
    assurance: "DEGRADED",
    checksPassed: passedCount,
    checksFailed: failedCount,
    checksSkipped: plan.checks.length - passedCount - failedCount,
    mandatoryPassed: mandatoryFailedList.length === 0,
    mandatoryFailed: mandatoryFailedList.length > 0,
    failureReasons: mandatoryFailedList.map(c => `fallback check ${c.checkId} failed`),
    evidenceDigest,
    persistenceFailed: false,
    checkResults,
    unresolvedObligations: [],
    providerState: "typescript_fallback",
  }
}

// ─── Attestation Generation and Verification (M9) ────────────────────────────

/**
 * Generate a cryptographically bound in-toto verification attestation (Milestone 9).
 *
 * In native mode: invokes `fdx attest create --run <id> --predicate-version <v1|v2> --format json`.
 * In fallback mode: returns fallback-typed reference without claiming in-toto authority.
 */
export async function createVerificationAttestation(
  runId: string,
  capabilities: FdxCapabilitySnapshot,
  repositoryRoot: string,
  options: {
    predicateVersion?: "v1" | "v2"
  } = {}
): Promise<FdxAttestationReference> {
  const predicate = options.predicateVersion ?? "v1"

  if (
    capabilities.providerState === "typescript_fallback" ||
    capabilities.providerState === "unavailable" ||
    capabilities.providerState === "incompatible" ||
    !capabilities.binaryPath
  ) {
    const attestationId = computeDigest(JSON.stringify({ runId, predicate, fallback: true }))
    return {
      attestationId,
      predicate,
      evidenceDigest: computeDigest(runId),
      runId,
      verificationRunId: runId,
      createdAt: new Date().toISOString(),
      verified: false,
      providerState: "typescript_fallback",
    }
  }

  const binary = capabilities.binaryPath
  const attestArgs = fdxAttestCreateArgs(runId, predicate)
  const execRes = await runFdxAsync(binary, attestArgs, QUERY_TIMEOUT_MS, repositoryRoot)

  if (execRes.exitCode !== 0 || !execRes.stdout) {
    const attestationId = computeDigest(JSON.stringify({ runId, predicate, error: "attest_create_failed" }))
    return {
      attestationId,
      predicate,
      evidenceDigest: computeDigest(runId),
      runId,
      verificationRunId: runId,
      createdAt: new Date().toISOString(),
      verified: false,
      providerState: capabilities.providerState,
    }
  }

  try {
    const parsed = JSON.parse(execRes.stdout) as Record<string, unknown>
    const sha256 = String(parsed["attestation_sha256"] ?? parsed["sha256"] ?? "")
    const path = parsed["path"] as string | undefined
    const artifactSha = (parsed["artifact_sha256"] as string | undefined) ?? (parsed["artifact_sha"] as string | undefined)

    return {
      attestationId: sha256 || computeDigest(execRes.stdout),
      predicate,
      attestationFilePath: path,
      artifactSha256: artifactSha,
      evidenceDigest: artifactSha ?? sha256,
      runId,
      verificationRunId: String(parsed["run_id"] ?? runId),
      createdAt: new Date().toISOString(),
      verified: true,
      providerState: capabilities.providerState,
    }
  } catch {
    const attestationId = computeDigest(JSON.stringify({ runId, predicate, parseError: true }))
    return {
      attestationId,
      predicate,
      evidenceDigest: computeDigest(runId),
      runId,
      verificationRunId: runId,
      createdAt: new Date().toISOString(),
      verified: false,
      providerState: capabilities.providerState,
    }
  }
}

/**
 * Verify an in-toto attestation against source run artifact and M8 runtime history.
 */
export async function verifyAttestationFile(
  attestationFilePath: string,
  capabilities: FdxCapabilitySnapshot,
  repositoryRoot: string,
  expectedSha256?: string
): Promise<{ verified: boolean; message: string; statement?: Record<string, unknown> }> {
  if (
    capabilities.providerState === "typescript_fallback" ||
    capabilities.providerState === "unavailable" ||
    capabilities.providerState === "incompatible" ||
    !capabilities.binaryPath
  ) {
    return { verified: false, message: "Attestation verification requires native FDX binary" }
  }

  const binary = capabilities.binaryPath
  const verifyArgs = fdxAttestVerifyArgs(attestationFilePath, expectedSha256)
  const execRes = await runFdxAsync(binary, verifyArgs, QUERY_TIMEOUT_MS, repositoryRoot)

  if (execRes.exitCode !== 0 || !execRes.stdout) {
    return {
      verified: false,
      message: `Attestation verification failed: ${execRes.error?.message ?? "process error"}`,
    }
  }

  try {
    const parsed = JSON.parse(execRes.stdout) as Record<string, unknown>
    const ok = parsed["valid"] === true || parsed["verified"] === true || parsed["status"] === "verified" || parsed["status"] === "valid"
    return {
      verified: ok,
      message: ok ? "Attestation verified valid" : String(parsed["error"] ?? "Attestation verification failed"),
      statement: parsed["statement"] as Record<string, unknown> | undefined,
    }
  } catch {
    return { verified: false, message: "Could not parse attestation verification output" }
  }
}

/** Legacy wrapper for generateAttestationReference */
export async function generateAttestationReference(
  evidence: FdxRuntimeEvidence,
  plan: FdxVerificationPlan,
  capabilities: FdxCapabilitySnapshot,
  repositoryRoot = "."
): Promise<FdxAttestationReference> {
  const predicate: "v1" | "v2" = plan.m11OverlayApplied ? "v2" : "v1"
  const ref = await createVerificationAttestation(evidence.runId, capabilities, repositoryRoot, { predicateVersion: predicate })
  return {
    ...ref,
    policyId: plan.m11OverlayApplied ? (plan.policySnapshotDigest ?? "snap-001") : undefined,
    policySnapshotDigest: plan.policySnapshotDigest,
    policyApplicationDigest: plan.policyApplicationDigest,
  }
}

/** Legacy wrapper for persistRuntimeEvidence */
export async function persistRuntimeEvidence(
  plan: FdxVerificationPlan,
  checkResults: Array<{ checkId: string; passed: boolean; output?: string }>,
  capabilities: FdxCapabilitySnapshot
): Promise<FdxRuntimeEvidence> {
  const passed = checkResults.filter(r => r.passed).length
  const failed = checkResults.filter(r => !r.passed).length
  const mandatoryIds = new Set(plan.checks.filter(c => c.mandatory).map(c => c.checkId))
  const mandatoryFailedList = checkResults.filter(r => mandatoryIds.has(r.checkId) && !r.passed)

  const evidenceDigest = computeDigest(JSON.stringify({
    planId: plan.planId,
    effectivePlanDigest: plan.effectivePlanDigest,
    results: checkResults.map(r => ({ checkId: r.checkId, passed: r.passed })),
  }))

  return {
    runId: plan.runId,
    verificationRunId: randomUUID(),
    stateFingerprint: evidenceDigest,
    outcome: failed > 0 ? "failed" : "passed",
    assurance: plan.assurance,
    checksPassed: passed,
    checksFailed: failed,
    checksSkipped: plan.checks.length - passed - failed,
    mandatoryPassed: mandatoryFailedList.length === 0,
    mandatoryFailed: mandatoryFailedList.length > 0,
    failureReasons: mandatoryFailedList.map(r => `check ${r.checkId} failed`),
    evidenceDigest,
    persistenceFailed: false,
    checkResults: checkResults.map(r => ({
      checkId: r.checkId,
      status: r.passed ? "passed" : "failed",
      command: [],
      durationMs: 0,
      passed: r.passed,
    })),
    unresolvedObligations: [],
    providerState: capabilities.providerState,
  }
}

// ─── Structured Blocker Classification ───────────────────────────────────────

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

  if (capabilities.providerState === "incompatible") {
    blockers.push({
      kind: "incompatible_capabilities",
      message: "FDX binary has incompatible capability or protocol contract",
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

  if (evidence.persistenceFailed) {
    blockers.push({
      kind: "persistence_failure",
      message: `M8 runtime evidence persistence failed: ${evidence.persistenceError ?? "unknown error"}`,
      heidiCanRepairDirectly: false,
      providerState: capabilities.providerState,
    })
  }

  if (capabilities.providerState === "native_vci_full" || capabilities.providerState === "native_vci_partial") {
    if (!plan.basePlanDigest || !plan.effectivePlanDigest || plan.digestAuthority !== "fdx_native" || plan.assurance === "UNVERIFIED") {
      blockers.push({
        kind: "missing_native_plan_digest",
        message: "Missing or non-native authoritative plan digest from FDX",
        heidiCanRepairDirectly: false,
        providerState: capabilities.providerState,
      })
    }
    if (plan.m11OverlayApplied && (!plan.policySnapshotDigest || !plan.policyApplicationDigest)) {
      blockers.push({
        kind: "policy_integrity_failure",
        message: "Policy overlay applied without complete native provenance (snapshot or application digest missing)",
        heidiCanRepairDirectly: false,
        providerState: capabilities.providerState,
      })
    }
  }

  for (const checkResult of (evidence.checkResults ?? [])) {
    if (!checkResult.passed) {
      const planCheck = plan.checks.find(c => c.checkId === checkResult.checkId)
      const cmdArr = Array.isArray(checkResult.command) ? checkResult.command : []
      blockers.push({
        kind: checkResult.status === "timed_out" ? "check_incomplete" : "check_failed",
        checkId: checkResult.checkId,
        command: cmdArr.join(" ") || planCheck?.command,
        message: checkResult.reason ?? `Check ${checkResult.checkId} failed with status ${checkResult.status}`,
        suggestedSpecialist: inferSpecialistFromCheck(checkResult.checkId, cmdArr),
        heidiCanRepairDirectly: isSimpleCheckFailure(checkResult.checkId, cmdArr),
        providerState: capabilities.providerState,
      })
    }
  }

  // Handle failureReasons not mapped to a specific check
  for (const reason of (evidence.failureReasons ?? [])) {
    if (!blockers.some(b => b.message === reason)) {
      const check = plan.checks.find(c => reason.includes(c.checkId))
      blockers.push({
        kind: "check_failed",
        checkId: check?.checkId,
        command: check?.command,
        message: reason,
        suggestedSpecialist: check ? inferSpecialistFromCheck(check.checkId, [check.command, ...check.args]) : undefined,
        heidiCanRepairDirectly: check ? isSimpleCheckFailure(check.checkId, [check.command, ...check.args]) : false,
        providerState: capabilities.providerState,
      })
    }
  }

  // Unresolved obligations
  for (const obligation of (evidence.unresolvedObligations ?? [])) {
    blockers.push({
      kind: "unresolved_obligation",
      checkId: obligation,
      message: `Unresolved verification obligation: ${obligation}`,
      heidiCanRepairDirectly: false,
      providerState: capabilities.providerState,
    })
  }

  return blockers
}

// ─── Status for Diagnostics ──────────────────────────────────────────────────

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

// ─── Content-Bound Repository State Fingerprint ──────────────────────────────

/**
 * Computes a deterministic repository state fingerprint.
 *
 * CRITICAL REQUIREMENT (D):
 * Must bind:
 *   1. git rev-parse HEAD
 *   2. git status --porcelain (status text)
 *   3. ACTUAL WORKING-TREE BYTES of all modified/dirty files.
 *   4. Content or presence of untracked files.
 *
 * Regression invariant:
 *   State A: HEAD = H, file X has content "AAA"
 *   State B: HEAD = H, file X has content "BBB"
 *   computeRepoStateFingerprint(A) !== computeRepoStateFingerprint(B)
 */
export function computeRepoStateFingerprint(repositoryRoot: string): string {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    }).trim()

    const statusOutput = execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    })

    const hasher = createHash("sha256")
    hasher.update(`HEAD:${head}\n`)
    hasher.update(`STATUS:${statusOutput}\n`)

    // Hash actual bytes of modified and untracked files
    const lines = statusOutput.split("\n").filter(l => l.trim().length > 0)
    for (const line of lines) {
      const code = line.slice(0, 2)
      let filePath = line.slice(3).trim()
      // Handle rename: "R  old -> new"
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ")[1].trim()
      }
      // Remove quotes if present
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1)
      }

      const fullPath = resolve(repositoryRoot, filePath)
      if (existsSync(fullPath)) {
        try {
          const stat = statSync(fullPath)
          if (stat.isFile()) {
            hasher.update(`FILE:${filePath}:${code}:${stat.size}\n`)
            // Read file content bytes (bounded to 4MB per file for performance)
            const content = readFileSync(fullPath)
            hasher.update(content.subarray(0, 4 * 1024 * 1024))
          }
        } catch {
          // If unreadable, include path in fingerprint so change is detected
          hasher.update(`UNREADABLE:${filePath}\n`)
        }
      } else {
        hasher.update(`DELETED:${filePath}\n`)
      }
    }

    return hasher.digest("hex").slice(0, 32)
  } catch {
    return createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 32)
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeDigest(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 32)
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

  if (checks.length === 0) {
    checks.push({
      checkId: "fallback:default-check",
      command: "bun",
      args: ["test"],
      rationale: "Default verification check",
      mandatory: true,
      policyAdded: false,
    })
  }

  return checks
}

function parsePlannedChecks(raw: unknown[]): FdxVerificationCheck[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(item => {
      if (!item || typeof item !== "object") return null
      const obj = item as Record<string, unknown>
      const checkId = String(obj["check_id"] ?? "")
      if (!checkId) return null
      return {
        checkId,
        displayName: obj["display_name"] as string | undefined,
        command: (obj["command"] as string) ?? "unknown",
        args: Array.isArray(obj["args"]) ? (obj["args"] as string[]) : [],
        workdir: obj["workdir"] as string | undefined,
        rationale: (obj["reason"] as string) ?? (obj["rationale"] as string) ?? "",
        mandatory: (obj["mandatory"] as boolean) ?? true,
        kind: obj["kind"] as string | undefined,
        policyAdded: obj["selection"] === "policy_overlay" || obj["policy_added"] === true,
        policyId: obj["policy_id"] as string | undefined,
      } as FdxVerificationCheck
    })
    .filter(Boolean) as FdxVerificationCheck[]
}

function inferSpecialistFromCheck(checkId: string, command: string[]): string | undefined {
  const checkStr = (checkId + " " + command.join(" ")).toLowerCase()
  if (checkStr.includes("cargo") || checkStr.includes(".rs")) return "rust"
  if (checkStr.includes("tsc") || checkStr.includes("typecheck") || checkStr.includes("typescript")) return "typescript"
  if (checkStr.includes("oxlint") || checkStr.includes("eslint") || checkStr.includes("lint")) return "lint"
  if (checkStr.includes("migration") || checkStr.includes("sqlite") || checkStr.includes("persistence")) return "persistence"
  if (checkStr.includes("test")) return "test"
  return undefined
}

function isSimpleCheckFailure(checkId: string, command: string[]): boolean {
  const checkStr = (checkId + " " + command.join(" ")).toLowerCase()
  return checkStr.includes("lint") || checkStr.includes("format") || checkStr.includes("fmt")
}
