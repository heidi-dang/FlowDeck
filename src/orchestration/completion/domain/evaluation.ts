/**
 * Completion evaluation domain model.
 *
 * Defines gates, typed failure codes, and structured evaluation results.
 */

import type { CompletionFailureCode } from "../../common/types"

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
 * Typed gate failure code plus structured facts.
 */
export interface GateFailure {
  readonly code: CompletionFailureCode
  readonly message: string
  readonly facts: readonly (readonly [string, string])[]
}

/**
 * Result of evaluating a single gate.
 */
export interface GateResult {
  readonly gateId: GateId
  readonly gateName: string
  readonly passed: boolean
  readonly failures: readonly GateFailure[]
  readonly reasons: readonly string[]
}

/**
 * Overall completion evaluation.
 */
export interface CompletionEvaluation {
  readonly allPassed: boolean
  readonly gates: readonly GateResult[]
  readonly passedGates: number
  readonly totalGates: number
  readonly failingGates: readonly GateResult[]
}

function deepFreezeGateResult(g: GateResult): GateResult {
  return Object.freeze({
    gateId: g.gateId,
    gateName: g.gateName,
    passed: g.passed,
    failures: Object.freeze(g.failures.map((f) => Object.freeze({ code: f.code, message: f.message, facts: Object.freeze(f.facts.map((x) => Object.freeze(x))) }))),
    reasons: Object.freeze([...g.reasons]),
  })
}

/**
 * Creates a typed gate result with failure codes.
 */
export function createGateResult(
  gateId: GateId,
  passed: boolean,
  failures: GateFailure[] = [],
  reasons: string[] = [],
): GateResult {
  return deepFreezeGateResult({
    gateId,
    gateName: GATE_NAMES[gateId],
    passed,
    failures: Object.freeze([...failures]),
    reasons: Object.freeze([...reasons]),
  })
}

/**
 * Aggregates gate results into a completion evaluation.
 * Deep-freezes the entire evaluation.
 */
export function aggregateEvaluation(gates: GateResult[]): CompletionEvaluation {
  const frozen = gates.map(deepFreezeGateResult)
  const passed = frozen.filter((g) => g.passed)
  const failing = frozen.filter((g) => !g.passed)

  return Object.freeze({
    allPassed: failing.length === 0,
    gates: Object.freeze(frozen),
    passedGates: passed.length,
    totalGates: frozen.length,
    failingGates: Object.freeze(failing),
  })
}
