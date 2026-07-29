/**
 * Canonical gate policy registry.
 *
 * Single source of truth for:
 * - Which gates exist
 * - Whether each gate is overridable
 * - What authority is required
 * - Whether approval is required for override
 */

import { type AuthorityLevel } from "../../common/types"

export type GateOverridePolicy =
  | { readonly kind: "not_overridable" }
  | {
      readonly kind: "overridable"
      readonly minimumAuthority?: AuthorityLevel
      readonly approvalRequired: boolean
    }

export interface GateDefinition {
  readonly id: string
  readonly name: string
  readonly overridePolicy: GateOverridePolicy
}

/**
 * The six completion gates with their override policies.
 */
export const GATE_POLICY_REGISTRY: Record<string, GateDefinition> = {
  "required-assignments-complete": {
    id: "required-assignments-complete",
    name: "Required assignments complete",
    overridePolicy: { kind: "not_overridable" },
  },
  "current-sha-matches-verification": {
    id: "current-sha-matches-verification",
    name: "Current SHA equals verification SHA",
    overridePolicy: { kind: "not_overridable" },
  },
  "critical-acceptance-criteria-passed": {
    id: "critical-acceptance-criteria-passed",
    name: "Required critical acceptance criteria passed",
    overridePolicy: { kind: "overridable", minimumAuthority: "release_manager", approvalRequired: true },
  },
  "critical-requirements-verified": {
    id: "critical-requirements-verified",
    name: "Required critical requirements verified",
    overridePolicy: { kind: "overridable", minimumAuthority: "release_manager", approvalRequired: true },
  },
  "verification-policy-satisfied": {
    id: "verification-policy-satisfied",
    name: "Required verification policy satisfied",
    overridePolicy: { kind: "overridable", minimumAuthority: "reviewer", approvalRequired: false },
  },
  "mandatory-evidence-current": {
    id: "mandatory-evidence-current",
    name: "Mandatory evidence is current and SHA-matched",
    overridePolicy: { kind: "overridable", minimumAuthority: "reviewer", approvalRequired: false },
  },
}

export function getGateDefinition(gateId: string): GateDefinition {
  const def = GATE_POLICY_REGISTRY[gateId]
  if (!def) {
    throw new Error(`Unknown gate ID: ${gateId}`)
  }
  return def
}

export function isGateOverridable(gateId: string): boolean {
  return getGateDefinition(gateId).overridePolicy.kind !== "not_overridable"
}

export function getGateOverridePolicy(gateId: string): GateOverridePolicy {
  return getGateDefinition(gateId).overridePolicy
}
