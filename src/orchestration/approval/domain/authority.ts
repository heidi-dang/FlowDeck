/**
 * Authority levels for the approval domain.
 * Do not rely on free-text role names inside policy logic.
 * Each level has a defined capability set.
 */

export type AuthorityLevel = "operator" | "reviewer" | "maintainer" | "release_manager" | "system"

export const AUTHORITY_HIERARCHY: Record<AuthorityLevel, number> = {
  operator: 10,
  reviewer: 30,
  maintainer: 50,
  release_manager: 70,
  system: 100,
}

export function hasSufficientAuthority(userLevel: AuthorityLevel, requiredLevel: AuthorityLevel): boolean {
  return AUTHORITY_HIERARCHY[userLevel] >= AUTHORITY_HIERARCHY[requiredLevel]
}

export function getRequiredAuthorityForGate(gateId: string): AuthorityLevel {
  // Non-overridable gates require system or release_manager
  switch (gateId) {
    case "current-sha-matches-verification":
    case "required-assignments-complete":
      return "maintainer"
    case "critical-acceptance-criteria-passed":
    case "critical-requirements-verified":
    case "verification-policy-satisfied":
    case "mandatory-evidence-current":
      return "reviewer"
    default:
      return "reviewer"
  }
}
