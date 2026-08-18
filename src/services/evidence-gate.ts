/**
 * EvidenceGate — evidence-gated completion/resolution (Requirement I).
 *
 * Prevents unsupported "resolved/fixed" claims. Runtime defects must never be
 * marked RESOLVED without evidence appropriate to the acceptance criteria.
 *
 * Verification evidence hierarchy (authority per evidence kind):
 *   live/real reproduction            (authority 5)
 *   integration/runtime-contract      (authority 4)
 *   focused acceptance test            (authority 3)
 *   unit regression test               (authority 2)
 *   model assertion                    (authority 1)
 *
 * A lower-authority PASS can never override a higher-authority FAIL.
 * Before OPEN -> RESOLVED, require evidence whose authority matches the
 * acceptance criteria; otherwise the claim is rejected (stays OPEN).
 */

export type EvidenceAuthority = 1 | 2 | 3 | 4 | 5

export type EvidenceKind =
  | "live_reproduction"
  | "integration_runtime_contract"
  | "focused_acceptance_test"
  | "unit_regression_test"
  | "model_assertion"

export const EVIDENCE_AUTHORITY: Record<EvidenceKind, EvidenceAuthority> = {
  live_reproduction: 5,
  integration_runtime_contract: 4,
  focused_acceptance_test: 3,
  unit_regression_test: 2,
  model_assertion: 1,
}

export interface VerificationEvidence {
  kind: EvidenceKind
  id: string
  outcome: "PASS" | "FAIL"
  detail?: string
  at: number;
}

export interface EvidenceGateResult {
  resolutionAllowed: boolean
  status: "OPEN" | "RESOLVED"
  reason: string
  highestAuthority: EvidenceAuthority
  highestAuthorityOutcome: "PASS" | "FAIL" | "UNKNOWN"
  blockedBy: VerificationEvidence[]
}

/**
 * Evaluate whether a defect/task may transition OPEN -> RESOLVED given the
 * collected verification evidence and the required minimum authority for the
 * acceptance criteria at hand.
 */
export function evaluateEvidenceGate(input: {
  taskId: string
  requiredKind: EvidenceKind
  requiredAuthority?: EvidenceAuthority;
  evidence: VerificationEvidence[];
}): EvidenceGateResult {
  const requiredAuthority = input.requiredAuthority ?? EVIDENCE_AUTHORITY[input.requiredKind]

  // Any FAIL at or above the required authority blocks resolution, regardless
  // of lower-authority PASSes.
  const blockers = input.evidence.filter(e =>
    e.outcome === "FAIL" && EVIDENCE_AUTHORITY[e.kind] >= requiredAuthority
  )

  if (blockers.length > 0) {
    return {
      resolutionAllowed: false,
      status: "OPEN",
      reason: "Higher-authority evidence FAILs: " + blockers.map(b => b.kind + "(" + b.id + ")").join(", "),
      highestAuthority: Math.max(...input.evidence.map(e => EVIDENCE_AUTHORITY[e.kind]), 0) as EvidenceAuthority,
      highestAuthorityOutcome: "FAIL",
      blockedBy: blockers,
    };
  }

  // Require at least one PASS at/above the required authority.
  const passes = input.evidence.filter(e =>
    e.outcome === "PASS" && EVIDENCE_AUTHORITY[e.kind] >= requiredAuthority
  );

  if (passes.length > 0) {
    return {
      resolutionAllowed: true,
      status: "RESOLVED",
      reason: "Evidence sufficient at authority " + requiredAuthority + " (".concat(passes.map(p => p.kind).join(", "), ")"),
      highestAuthority: Math.max(...input.evidence.map(e => EVIDENCE_AUTHORITY[e.kind]), 0) as EvidenceAuthority,
      highestAuthorityOutcome: "PASS",
      blockedBy: [],
    };
  }

  return {
    resolutionAllowed: false,
    status: "OPEN",
    reason: "No PASS at or above required authority " + requiredAuthority + " for task " + input.taskId,
    highestAuthority: input.evidence.length > 0 ? (Math.max(...input.evidence.map(e => EVIDENCE_AUTHORITY[e.kind])) as EvidenceAuthority) : 0 as EvidenceAuthority,
    highestAuthorityOutcome: highestAuthorityOutcome(input.evidence),
    blockedBy: [],
  };
}


function highestAuthorityOutcome(evidence: VerificationEvidence[]): "PASS" | "FAIL" | "UNKNOWN" {
  if (evidence.length === 0) return "UNKNOWN"
  let bestAuth = 0
  let outcome: "PASS" | "FAIL" | "UNKNOWN" = "UNKNOWN"
  for (const e of evidence) {
    if (EVIDENCE_AUTHORITY[e.kind] > bestAuth) {
      bestAuth = EVIDENCE_AUTHORITY[e.kind]
      outcome = e.outcome
    } else if (EVIDENCE_AUTHORITY[e.kind] === bestAuth && outcome === "UNKNOWN") {
      outcome = e.outcome
    }
  }
  return outcome
}


/**
 * Example: unit regression test PASS but production implementation unchanged
 * and live reproduction FAIL -> OPEN. This is the systemic behavior the
 * delegation bug demanded.
 */
export function requireLiveEvidence(defectId: string, evidence: VerificationEvidence[]): EvidenceGateResult {
  return evaluateEvidenceGate({
    taskId: defectId,
    requiredKind: "live_reproduction",
    evidence,
  });
}
