/**
 * Policy version identifiers.
 * Each policy has a stable version that is captured in completion decisions
 * so that historical decisions remain explainable after policy changes.
 */

export const POLICY_VERSIONS = {
  SIX_GATE_EVALUATION: "six-gate-evaluation-v1",
  APPROVAL_POLICY: "approval-policy-v1",
  OVERRIDE_POLICY: "override-policy-v1",
  AUTHORITY_POLICY: "authority-policy-v1",
} as const

export const CURRENT_POLICY_VERSION = "1.0.0"

export function getCompletionPolicyVersion(): string {
  return CURRENT_POLICY_VERSION
}
