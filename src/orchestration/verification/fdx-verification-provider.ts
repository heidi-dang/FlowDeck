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

  // Step 1: Native FDX is the sole authority for completion-grade VCI evidence.
  // General FlowDeck tooling may expose a typed fallback, but this provider must
  // never execute it or convert it into a completion result.
  if (capabilities.providerState !== "native_vci_full" || !capabilities.binaryPath) {
    const reason = `Native FDX authority unavailable: ${capabilities.providerState}`
    const plan: FdxVerificationPlan = {
      planId: sessionId,
      runId,
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
      runId,
      verificationRunId: sessionId,
      stateFingerprint: changeIntelligence.stateFingerprint,
      outcome: "incomplete",
      assurance: "UNVERIFIED",
      checksPassed: 0,
      checksFailed: 0,
      checksSkipped: 0,
      mandatoryPassed: false,
      mandatoryFailed: true,
      failureReasons: [reason],
      evidenceDigest: "",
      persistenceFailed: true,
      persistenceError: reason,
      checkResults: [],
      unresolvedObligations: ["native_fdx_authority_required"],
      providerState: capabilities.providerState,
    }
    const session: FdxVerificationSession = {
      sessionId,
      runId,
      stateVersion: changeIntelligence.stateVersion,
      stateFingerprint: changeIntelligence.stateFingerprint,
      targetSha: changeIntelligence.headSha,
      basePlanDigest: "",
      effectivePlanDigest: "",
      plan,
      evidence,
      blockers: [{
        kind: capabilities.providerState === "incompatible" ? "incompatible_capabilities" : "provider_unavailable",
        message: reason,
        heidiCanRepairDirectly: false,
        providerState: capabilities.providerState,
      }],
      status: "failed",
      createdAt: now,
      completedAt: new Date().toISOString(),
    }
    const result: VerificationResult = {
      id: sessionId,
      runId,
      checkType: options.checkType ?? "fdx_vci",
      status: VerificationStatus.ERROR,
      correlationId,
      causationId: options.causationId,
      result: reason,
      stateVersion: changeIntelligence.stateVersion,
      stateFingerprint: changeIntelligence.stateFingerprint,
      targetSha: changeIntelligence.headSha,
      evidenceIds: [],
      failureReasons: [reason],
      createdAt: now,
      updatedAt: new Date().toISOString(),
    }
    emit(`[FDX Complete] Verification blocked: ${reason}`)
    return { result, session, blockers: session.blockers }
  }

  emit("[FDX Verify] Starting native FDX verification execution...")
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

  // Step 2: Native evidence must be complete before M9 can create a statement.
  // This prevents a failed or uncertain M8 write from ever producing a durable
  // attestation that a later layer could mistake for completion evidence.
  const nativeProvenanceValid =
    plan.digestAuthority === "fdx_native" &&
    plan.basePlanDigest.length > 0 &&
    plan.effectivePlanDigest.length > 0 &&
    (!plan.m11OverlayApplied || (!!plan.policySnapshotDigest && !!plan.policyApplicationDigest))
  const evidenceEligibleForAttestation =
    evidence.outcome === "passed" &&
    evidence.mandatoryPassed &&
    !evidence.persistenceFailed &&
    evidence.failureReasons.length === 0 &&
    nativeProvenanceValid &&
    plan.assurance !== "UNVERIFIED" &&
    evidence.assurance !== "UNVERIFIED"
  const predicateVersion: "v1" | "v2" = plan.m11OverlayApplied ? "v2" : "v1"
  if (evidenceEligibleForAttestation) {
    emit(`[FDX Attestation] Generating ${predicateVersion} attestation...`)
  }
  const attestation: FdxAttestationReference = evidenceEligibleForAttestation
    ? await createVerificationAttestation(evidence.verificationRunId, capabilities, changeIntelligence.repositoryRoot, { predicateVersion })
    : {
      attestationId: "",
      predicate: predicateVersion,
      evidenceDigest: "",
      runId,
      verificationRunId: evidence.verificationRunId,
      createdAt: new Date().toISOString(),
      verified: false,
      providerState: capabilities.providerState,
    }
  session.attestation = attestation

  // Step 3: Classify failures into structured blockers
  const blockers = classifyVerificationFailures(evidence, plan, capabilities)
  if (!attestation.verified) {
    blockers.push({
      kind: "attestation_failure",
      message: evidenceEligibleForAttestation
        ? "M9 native attestation was not verified"
        : "M9 native attestation was withheld because M7/M8 evidence was not completion-eligible",
      heidiCanRepairDirectly: false,
      providerState: capabilities.providerState,
    })
  }
  session.blockers = blockers

  // Step 4: Evaluate overall outcome. A verified native M9 statement is required
  // in addition to successful M7 execution and M8 persistence.
  const passed =
    evidenceEligibleForAttestation &&
    attestation.verified

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
    evidenceIds: passed ? [evidence.evidenceDigest, attestation.attestationId] : [],
    failureReasons: passed
      ? evidence.failureReasons
      : [...evidence.failureReasons, ...blockers.filter(blocker => blocker.kind === "attestation_failure").map(blocker => blocker.message)],
    stateVersion: changeIntelligence.stateVersion,
    stateFingerprint: changeIntelligence.stateFingerprint,
    targetSha: changeIntelligence.headSha,
    metadata: {
      basePlanDigest: plan.basePlanDigest,
      effectivePlanDigest: plan.effectivePlanDigest,
      policySnapshotDigest: plan.policySnapshotDigest,
      policyApplicationDigest: plan.policyApplicationDigest,
      digestAuthority: plan.digestAuthority,
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
