/**
 * FDX Verification Provider
 *
 * Wires FDX VCI as the authoritative verification intelligence for
 * the orchestration VerificationService.
 *
 * Architecture:
 *   VerificationService (orchestration boundary)
 *         │
 *         ▼
 *   FdxVerificationProvider (this module)
 *         │
 *         ▼
 *   FDX VCI Adapter → native fdx verify / attest / runtime evidence
 *
 * Authority rules:
 *   1. In native mode, native FDX executes verification directly (M7) and produces M8 evidence.
 *   2. Persistence failure (M8) fails closed: verification status is FAILED/ERROR, blocking completion.
 *   3. Real in-toto attestation (M9) is generated via FDX attest and verified.
 *   4. State binding: every verification is bound to (stateVersion + stateFingerprint + targetSha).
 *   5. Stale evidence is rejected.
 */

import { randomUUID } from "node:crypto"
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
  executeNativeVerification,
  createVerificationAttestation,
  classifyVerificationFailures,
} from "../../services/fdx-vci-adapter"

// ─── Provider Session State ──────────────────────────────────────────────────

export interface FdxVerificationSession {
  sessionId: string
  runId: string
  stateVersion: number
  stateFingerprint: string
  targetSha?: string
  basePlanDigest: string
  effectivePlanDigest: string
  policySnapshotDigest?: string
  policyApplicationDigest?: string
  plan: FdxVerificationPlan
  evidence?: FdxRuntimeEvidence
  attestation?: FdxAttestationReference
  blockers: FdxVerificationBlocker[]
  status: "pending" | "in_progress" | "passed" | "failed" | "cancelled" | "stale"
  createdAt: string
  completedAt?: string
}

// ─── Main Provider Function ──────────────────────────────────────────────────

/**
 * Execute a complete FDX-authoritative verification cycle.
 *
 * Returns a VerificationResult that VerificationService persists.
 * FDX plan digest, evidence digest, and attestation identity are embedded as durable correlation.
 */
export async function runFdxVerification(
  runId: string,
  changeIntelligence: FdxChangeIntelligence,
  capabilities: FdxCapabilitySnapshot,
  options: {
    correlationId?: string
    causationId?: string
    checkType?: string
    policyOverlay?: boolean
    failFast?: boolean
    noPersist?: boolean
    onProgress?: (msg: string) => void
    signal?: AbortSignal
    timeoutMs?: number
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

  // Step 1: Execute verification (M7) via native FDX or fallback
  emit("[FDX Verify] Starting verification execution...")
  const { plan, evidence } = await executeNativeVerification(
    changeIntelligence,
    capabilities,
    {
      policyOverlay: options.policyOverlay,
      failFast: options.failFast,
      noPersist: options.noPersist,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onProgress: emit,
    }
  )

  const session: FdxVerificationSession = {
    sessionId,
    runId,
    stateVersion: changeIntelligence.stateVersion,
    stateFingerprint: changeIntelligence.stateFingerprint,
    targetSha: changeIntelligence.headSha,
    basePlanDigest: plan.basePlanDigest,
    effectivePlanDigest: plan.effectivePlanDigest,
    policySnapshotDigest: plan.policySnapshotDigest,
    policyApplicationDigest: plan.policyApplicationDigest,
    plan,
    evidence,
    blockers: [],
    status: "in_progress",
    createdAt: now,
  }

  // Handle cancellation
  if (options.signal?.aborted || evidence.outcome === "incomplete" && evidence.failureReasons.some(r => r.includes("CANCELLED"))) {
    session.status = "cancelled"
    session.completedAt = new Date().toISOString()
    const result: VerificationResult = {
      id: sessionId,
      runId,
      checkType: options.checkType ?? "fdx_vci",
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

  // Step 2: Generate attestation reference (M9)
  const predicateVersion: "v1" | "v2" = plan.m11OverlayApplied ? "v2" : "v1"
  emit(`[FDX Attestation] Generating ${predicateVersion} attestation...`)
  const attestation = await createVerificationAttestation(
    runId,
    capabilities,
    changeIntelligence.repositoryRoot,
    { predicateVersion }
  )
  session.attestation = attestation

  // Step 3: Classify failures into structured blockers
  const blockers = classifyVerificationFailures(evidence, plan, capabilities)
  session.blockers = blockers

  // Step 4: Evaluate overall outcome
  // Criteria for PASS:
  //   1. evidence.outcome === "passed"
  //   2. evidence.mandatoryPassed === true
  //   3. evidence.persistenceFailed === false (M8 fail closed)
  //   4. evidence.failureReasons.length === 0
  const passed =
    evidence.outcome === "passed" &&
    evidence.mandatoryPassed &&
    !evidence.persistenceFailed &&
    evidence.failureReasons.length === 0

  session.status = passed ? "passed" : "failed"
  session.completedAt = new Date().toISOString()

  const result: VerificationResult = {
    id: sessionId,
    runId,
    checkType: options.checkType ?? "fdx_vci",
    status: passed ? VerificationStatus.PASSED : VerificationStatus.FAILED,
    correlationId,
    causationId: options.causationId,
    result: passed
      ? `FDX VCI verification passed. ${evidence.checksPassed}/${plan.checks.length} checks passed. Attestation: ${attestation.predicate} (${attestation.attestationId.slice(0, 8)})`
      : `FDX VCI verification failed: ${evidence.failureReasons.join(", ")}`,
    evidenceIds: [evidence.evidenceDigest, attestation.attestationId],
    failureReasons: evidence.failureReasons,
    stateVersion: changeIntelligence.stateVersion,
    stateFingerprint: changeIntelligence.stateFingerprint,
    targetSha: changeIntelligence.headSha,
    metadata: {
      basePlanDigest: plan.basePlanDigest,
      effectivePlanDigest: plan.effectivePlanDigest,
      policySnapshotDigest: plan.policySnapshotDigest,
      policyApplicationDigest: plan.policyApplicationDigest,
      attestationPredicate: attestation.predicate,
      attestationId: attestation.attestationId,
      attestationVerified: attestation.verified,
      evidenceDigest: evidence.evidenceDigest,
      providerState: capabilities.providerState,
      m11OverlayApplied: plan.m11OverlayApplied,
      assurance: evidence.assurance,
      persistenceFailed: evidence.persistenceFailed,
      persistedArtifactPath: evidence.persistedArtifactPath,
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
