/**
 * FDX Verification Provider
 *
 * Wires FDX VCI as the authoritative verification intelligence for
 * the orchestration VerificationService. VerificationService remains the
 * orchestration boundary; FDX supplies the actual change-aware plans and evidence.
 *
 * Architecture:
 *   VerificationService (orchestration boundary)
 *         │
 *         ▼
 *   FdxVerificationProvider (this module)
 *         │
 *         ▼
 *   FDX VCI Adapter → fdx plan / verify / runtime evidence
 *
 * State binding: every verification is bound to a specific repository state
 * (stateVersion + stateFingerprint + targetSha). Stale evidence is rejected.
 *
 * Shared execution: multiple logical obligations can map to one physical process
 * via the checkId dedup set.
 */

import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import type { VerificationResult } from "../types"
import { VerificationStatus } from "../types"
import type {
  FdxCapabilitySnapshot,
  FdxChangeIntelligence,
  FdxVerificationPlan,
  FdxRuntimeEvidence,
  FdxAttestationReference,
  FdxVerificationBlocker,
} from "../../services/fdx-vci-adapter"
import {
  generateVerificationPlan,
  persistRuntimeEvidence,
  generateAttestationReference,
  classifyVerificationFailures,
} from "../../services/fdx-vci-adapter"

const EXECUTION_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 256_000

// ─── Dedup registry ──────────────────────────────────────────────────────────
// Maps checkId → execution result (shared execution semantics, M7/M8)
const _executionRegistry = new Map<string, Promise<{ passed: boolean; output: string }>>()

function clearExecutionRegistry(): void {
  _executionRegistry.clear()
}

// ─── Provider state ───────────────────────────────────────────────────────────

export interface FdxVerificationSession {
  sessionId: string
  runId: string
  stateVersion: number
  stateFingerprint: string
  targetSha?: string
  basePlanDigest: string
  effectivePlanDigest: string
  policySnapshotDigest?: string
  plan: FdxVerificationPlan
  evidence?: FdxRuntimeEvidence
  attestation?: FdxAttestationReference
  blockers: FdxVerificationBlocker[]
  status: "pending" | "in_progress" | "passed" | "failed" | "cancelled" | "stale"
  createdAt: string
  completedAt?: string
}

// ─── Main provider ────────────────────────────────────────────────────────────

/**
 * Generate and execute a complete FDX-authoritative verification cycle.
 *
 * Returns a VerificationResult that the VerificationService can persist.
 * The FDX plan digest and evidence digest are embedded as durable correlation.
 */
export async function runFdxVerification(
  runId: string,
  changeIntelligence: FdxChangeIntelligence,
  capabilities: FdxCapabilitySnapshot,
  options: {
    correlationId?: string
    causationId?: string
    maxRetries?: number
    onProgress?: (msg: string) => void
    signal?: AbortSignal
  } = {}
): Promise<{
  result: VerificationResult
  session: FdxVerificationSession
  blockers: FdxVerificationBlocker[]
}> {
  const sessionId = randomUUID()
  const correlationId = options.correlationId ?? randomUUID()
  const now = new Date().toISOString()
  const emit = options.onProgress ?? (() => undefined)

  // Step 1: Generate plan (M6 base + M11 overlay)
  emit("[FDX Plan] Generating verification plan...")
  const plan = await generateVerificationPlan(changeIntelligence, capabilities)
  emit(`[FDX Plan] ${plan.checks.length} checks selected${plan.m11OverlayApplied ? " (+M11 overlay)" : ""}`)

  const session: FdxVerificationSession = {
    sessionId,
    runId,
    stateVersion: changeIntelligence.stateVersion,
    stateFingerprint: changeIntelligence.stateFingerprint,
    basePlanDigest: plan.basePlanDigest,
    effectivePlanDigest: plan.effectivePlanDigest,
    policySnapshotDigest: plan.policySnapshotDigest,
    plan,
    blockers: [],
    status: "in_progress",
    createdAt: now,
  }

  // Step 2: Execute checks (M7) with shared-execution dedup
  emit("[FDX Verify] Executing verification checks...")
  clearExecutionRegistry()

  const checkResults: Array<{ checkId: string; passed: boolean; output: string }> = []

  for (const check of plan.checks) {
    if (options.signal?.aborted) {
      session.status = "cancelled"
      break
    }

    emit(`[FDX Verify] Running ${check.checkId}...`)

    // Shared execution dedup: if same checkId already running, reuse its result
    let execPromise = _executionRegistry.get(check.checkId)
    if (!execPromise) {
      execPromise = executeCheck(check, changeIntelligence.repositoryRoot, options.signal)
      _executionRegistry.set(check.checkId, execPromise)
    }

    const result = await execPromise
    checkResults.push({ checkId: check.checkId, passed: result.passed, output: result.output })
  }

  if (session.status === "cancelled") {
    const result: VerificationResult = {
      id: sessionId,
      runId,
      checkType: "fdx_vci",
      status: VerificationStatus.ERROR,
      correlationId,
      causationId: options.causationId,
      result: "Verification cancelled",
      stateVersion: changeIntelligence.stateVersion,
      stateFingerprint: changeIntelligence.stateFingerprint,
      evidenceIds: [],
      failureReasons: ["CANCELLED"],
      createdAt: now,
      updatedAt: new Date().toISOString(),
    }
    return { result, session, blockers: [] }
  }

  // Step 3: Persist runtime evidence (M8)
  emit("[FDX Runtime Evidence] Persisting evidence...")
  const evidence = await persistRuntimeEvidence(plan, checkResults, capabilities)
  session.evidence = evidence

  // Step 4: Generate attestation reference (M9)
  const attestation = await generateAttestationReference(evidence, plan, capabilities)
  session.attestation = attestation

  // Step 5: Classify failures into structured blockers
  const blockers = classifyVerificationFailures(evidence, plan, capabilities)
  session.blockers = blockers

  // Step 6: Build final VerificationResult
  const passed = !evidence.mandatoryFailed && evidence.failureReasons.length === 0
  session.status = passed ? "passed" : "failed"
  session.completedAt = new Date().toISOString()

  const result: VerificationResult = {
    id: sessionId,
    runId,
    checkType: "fdx_vci",
    status: passed ? VerificationStatus.PASSED : VerificationStatus.FAILED,
    correlationId,
    causationId: options.causationId,
    result: passed
      ? `FDX VCI verification passed. ${evidence.checksPassed}/${plan.checks.length} checks passed. Attestation: ${attestation.predicate}`
      : `FDX VCI verification failed: ${evidence.failureReasons.join(", ")}`,
    evidenceIds: [evidence.evidenceDigest, attestation.attestationId],
    failureReasons: evidence.failureReasons,
    stateVersion: changeIntelligence.stateVersion,
    stateFingerprint: changeIntelligence.stateFingerprint,
    metadata: {
      basePlanDigest: plan.basePlanDigest,
      effectivePlanDigest: plan.effectivePlanDigest,
      policySnapshotDigest: plan.policySnapshotDigest,
      attestationPredicate: attestation.predicate,
      attestationId: attestation.attestationId,
      evidenceDigest: evidence.evidenceDigest,
      providerState: capabilities.providerState,
      m11OverlayApplied: plan.m11OverlayApplied,
    },
    createdAt: now,
    updatedAt: new Date().toISOString(),
  }

  emit(
    passed
      ? `[FDX Complete] Verification passed (predicate ${attestation.predicate})`
      : `[FDX Complete] Verification FAILED: ${evidence.failureReasons.join(", ")}`
  )

  return { result, session, blockers }
}

/**
 * Reject stale FDX evidence.
 *
 * A verification result is stale when the repository state has changed
 * since the verification was performed. CompletionPolicy must call this
 * before accepting evidence as valid.
 */
export function isFdxEvidenceStale(
  result: VerificationResult,
  currentStateFingerprint: string,
  currentStateVersion: number
): boolean {
  if (!result.stateFingerprint || !result.stateVersion) return true
  if (result.stateFingerprint !== currentStateFingerprint) return true
  if (result.stateVersion < currentStateVersion) return true
  return false
}

// ─── Single check execution ───────────────────────────────────────────────────

function executeCheck(
  check: { checkId: string; command: string; args: string[]; workdir?: string },
  repositoryRoot: string,
  signal?: AbortSignal
): Promise<{ passed: boolean; output: string }> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve({ passed: false, output: "CANCELLED" })
      return
    }

    const child = execFile(
      check.command,
      check.args,
      {
        cwd: check.workdir ?? repositoryRoot,
        timeout: EXECUTION_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (err, stdout, stderr) => {
        const output = (stdout + stderr).slice(0, MAX_OUTPUT_BYTES)
        resolve({ passed: !err, output })
      }
    )

    const onAbort = () => {
      child.kill("SIGTERM")
      resolve({ passed: false, output: "CANCELLED_BY_SIGNAL" })
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    child.on("close", () => signal?.removeEventListener("abort", onAbort))
  })
}