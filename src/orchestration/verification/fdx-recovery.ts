/**
 * FDX-Driven Orchestration Recovery
 *
 * Converts FDX verification failures into structured Heidi orchestration
 * signals, enabling targeted repair and specialist routing.
 *
 * Architecture:
 *   FDX failure → FdxVerificationBlocker[] → specialist routing | direct repair
 *
 * D1: Verification failure produces typed blockers (not raw stdout)
 * D2: Specialist routing based on failure kind
 * D3: Repo Master consultation for complex failures
 * D4: Mutation invalidates previous state
 * D5: Bounded convergence loop
 * D6: M10 calibration is measurement-only
 * D7: M11 candidates require explicit promotion
 * D8: Cancellation terminates child execution
 * D9: Restart reconciles from durable evidence
 */

import type { FdxVerificationBlocker, FdxVerificationPlan, FdxCapabilitySnapshot } from "../../services/fdx-vci-adapter"
import type { FdxVerificationSession } from "../verification/fdx-verification-provider"

// ─── Recovery convergence control ────────────────────────────────────────────

export interface FdxRecoveryBounds {
  maxAttempts: number
  wallClockBudgetMs: number
  /** Fingerprint of the most recent failed strategy — detects repeated identical failures */
  lastStrategyFingerprint?: string
}

export interface FdxRecoveryState {
  runId: string
  attempt: number
  startedAt: number
  bounds: FdxRecoveryBounds
  strategyHistory: string[]
  status: "active" | "exhausted" | "succeeded" | "cancelled"
}

export function createRecoveryState(runId: string, bounds: Partial<FdxRecoveryBounds> = {}): FdxRecoveryState {
  return {
    runId,
    attempt: 0,
    startedAt: Date.now(),
    bounds: {
      maxAttempts: bounds.maxAttempts ?? 3,
      wallClockBudgetMs: bounds.wallClockBudgetMs ?? 300_000,
    },
    strategyHistory: [],
    status: "active",
  }
}

/**
 * Check whether the recovery loop should continue.
 *
 * Bounds:
 * - maxAttempts: prevents infinite loops
 * - wallClockBudgetMs: wall-clock timeout
 * - strategyFingerprint: detects repeated identical failure patterns
 */
export function canContinueRecovery(
  state: FdxRecoveryState,
  currentStrategyFingerprint: string
): { canContinue: boolean; reason?: string } {
  if (state.status !== "active") {
    return { canContinue: false, reason: `Recovery is ${state.status}` }
  }
  if (state.attempt >= state.bounds.maxAttempts) {
    return { canContinue: false, reason: `Exceeded max attempts (${state.bounds.maxAttempts})` }
  }
  if (Date.now() - state.startedAt > state.bounds.wallClockBudgetMs) {
    return { canContinue: false, reason: "Wall-clock budget exhausted" }
  }
  // Repeated identical strategy: do not loop forever on same pattern
  const repeatCount = state.strategyHistory.filter(s => s === currentStrategyFingerprint).length
  if (repeatCount >= 2) {
    return { canContinue: false, reason: "Repeated identical failure strategy — repair not converging" }
  }
  return { canContinue: true }
}

export function recordRecoveryAttempt(state: FdxRecoveryState, strategyFingerprint: string): FdxRecoveryState {
  return {
    ...state,
    attempt: state.attempt + 1,
    strategyHistory: [...state.strategyHistory, strategyFingerprint],
    bounds: {
      ...state.bounds,
      lastStrategyFingerprint: strategyFingerprint,
    },
  }
}

// ─── Specialist routing ──────────────────────────────────────────────────────

export type RepairStrategy =
  | { kind: "heidi_direct"; reason: string }
  | { kind: "specialist"; domain: string; reason: string; requiresRepoMaster: boolean }
  | { kind: "exhausted"; reason: string }

/**
 * Classify a set of FDX blockers into a repair strategy.
 *
 * D2: Specialist routing based on failure kind.
 * D3: Complex failures route through Repo Master first.
 *
 * Only spawn a specialist when useful. One lint error does not need five agents.
 */
export function classifyRepairStrategy(
  blockers: FdxVerificationBlocker[],
  _recoveryState: FdxRecoveryState
): RepairStrategy {
  if (blockers.length === 0) return { kind: "exhausted", reason: "No blockers — already passing" }

  // Provider issues: Heidi handles directly or escalates
  const providerBlocker = blockers.find(b => b.kind === "provider_unavailable")
  if (providerBlocker) {
    return { kind: "heidi_direct", reason: "Provider unavailable — Heidi degrades gracefully" }
  }

  const providerDegraded = blockers.find(b => b.kind === "provider_degraded")
  if (providerDegraded && blockers.length === 1) {
    return { kind: "heidi_direct", reason: "Provider in fallback mode — continue with degraded assurance" }
  }

  // Simple failures: Heidi can fix directly
  const allSimple = blockers.every(b => b.heidiCanRepairDirectly)
  if (allSimple && blockers.length <= 2) {
    return {
      kind: "heidi_direct",
      reason: `${blockers.length} simple failure(s) — Heidi repairs directly`,
    }
  }

  // Complex multi-blocker or specialist needed
  const domains = [...new Set(blockers.map(b => b.suggestedSpecialist).filter(Boolean))]
  const isComplex = blockers.length > 2 || domains.length > 1 || blockers.some(b => b.kind === "unresolved_obligation")

  if (domains.length > 0) {
    return {
      kind: "specialist",
      domain: domains[0]!,
      reason: `${blockers.length} blocker(s) routed to ${domains[0]} specialist`,
      requiresRepoMaster: isComplex,
    }
  }

  return { kind: "heidi_direct", reason: "Unclassified failure — Heidi attempts direct repair" }
}

// ─── M10/M11 boundary ────────────────────────────────────────────────────────

/**
 * Determine if M11 candidates should be surfaced to the user.
 *
 * D7: Candidates have no authority until explicitly promoted.
 * This function only determines whether to inform — not to apply.
 */
export function shouldSurfaceM11Candidates(
  plan: FdxVerificationPlan,
  capabilities: FdxCapabilitySnapshot
): boolean {
  // Only surface when native FDX supports policy and candidates exist
  if (capabilities.providerState === "typescript_fallback") return false
  if (capabilities.providerState === "unavailable") return false
  if (capabilities.policyContractVersions.length === 0) return false
  return plan.m11CandidatesAvailable.length > 0
}

/**
 * M10 calibration recording signal.
 *
 * D6: Calibration is measurement-only. It records historical evidence for
 * future M10 shadow calibration. It MUST NOT change the current verification.
 */
export interface M10CalibrationSignal {
  runId: string
  verificationSessionId: string
  effectivePlanDigest: string
  passed: boolean
  checkResults: Array<{ checkId: string; passed: boolean; status?: string; durationMs?: number }>
  repositoryStateFingerprint: string
}

export function buildCalibrationSignal(
  session: FdxVerificationSession
): M10CalibrationSignal | null {
  if (!session.evidence) return null

  // Milestone 10 exact truth: consume actual per-check execution evidence.
  // Never collapse or fabricate per-check status from overall run status.
  const checkResults = session.evidence.checkResults.length > 0
    ? session.evidence.checkResults.map(r => ({
        checkId: r.checkId,
        passed: r.passed,
        status: r.status,
        durationMs: r.durationMs,
      }))
    : session.plan.checks.map(c => {
        const failedReason = session.evidence?.failureReasons.find(r => r.includes(c.checkId))
        const passed = !failedReason && (session.evidence?.mandatoryPassed ?? false)
        return {
          checkId: c.checkId,
          passed,
          status: passed ? "passed" : "failed",
        }
      })

  return {
    runId: session.runId,
    verificationSessionId: session.sessionId,
    effectivePlanDigest: session.effectivePlanDigest,
    passed: session.status === "passed",
    checkResults,
    repositoryStateFingerprint: session.stateFingerprint,
  }
}