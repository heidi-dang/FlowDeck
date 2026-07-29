/**
 * Completion evaluation domain model.
 *
 * Defines the six gates, gate results, and the overall completion evaluation.
 * Override support will be added in Phase 2C.
 */

/**
 * The six completion gate identifiers.
 */
export type GateId =
  | "required-assignments-complete"
  | "current-sha-matches-verification"
  | "critical-acceptance-criteria-passed"
  | "critical-requirements-verified"
  | "verification-policy-satisfied"
  | "mandatory-evidence-current"

/**
 * Human-readable gate names.
 */
export const GATE_NAMES: Record<GateId, string> = {
  "required-assignments-complete": "Required assignments complete",
  "current-sha-matches-verification": "Current SHA equals verification SHA",
  "critical-acceptance-criteria-passed": "Required critical acceptance criteria passed",
  "critical-requirements-verified": "Required critical requirements verified",
  "verification-policy-satisfied": "Required verification policy satisfied",
  "mandatory-evidence-current": "Mandatory evidence is current and SHA-matched",
}

/**
 * Result of evaluating a single gate.
 */
export interface GateResult {
  readonly gateId: GateId
  readonly gateName: string
  readonly passed: boolean
  readonly reasons: readonly string[]
}

/**
 * Overall completion evaluation.
 * An evaluation passes when ALL six gates pass.
 */
export interface CompletionEvaluation {
  readonly allPassed: boolean
  readonly gates: readonly GateResult[]
  readonly passedGates: number
  readonly totalGates: number
  readonly failingGates: readonly GateResult[]
}

/**
 * Creates a gate result.
 */
export function createGateResult(gateId: GateId, passed: boolean, reasons: string[] = []): GateResult {
  return {
    gateId,
    gateName: GATE_NAMES[gateId],
    passed,
    reasons: Object.freeze([...reasons]),
  }
}

/**
 * Aggregates gate results into a completion evaluation.
 */
export function aggregateEvaluation(gates: GateResult[]): CompletionEvaluation {
  const passed = gates.filter((g) => g.passed)
  const failing = gates.filter((g) => !g.passed)

  return {
    allPassed: failing.length === 0,
    gates: Object.freeze([...gates]),
    passedGates: passed.length,
    totalGates: gates.length,
    failingGates: Object.freeze([...failing]),
  }
}
