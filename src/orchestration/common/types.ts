/**
 * Shared branded types for the orchestration domain.
 */

/** ISO-8601 instant string — branded for type safety. */
export type Instant = string & { readonly __brand: "Instant" }

export function toInstant(date: Date): Instant {
  return date.toISOString() as Instant
}

export function nowInstant(): Instant {
  return toInstant(new Date())
}

/** Strongly-typed policy version. */
export type PolicyVersion = string & { readonly __brand: "PolicyVersion" }

export const CURRENT_POLICY_VERSION = "1.0.0" as PolicyVersion

/** Authority levels — never use free-text strings. */
export type AuthorityLevel =
  | "operator"
  | "reviewer"
  | "maintainer"
  | "release_manager"
  | "system"

export const AUTHORITY_HIERARCHY: Record<AuthorityLevel, number> = {
  operator: 10,
  reviewer: 30,
  maintainer: 50,
  release_manager: 70,
  system: 100,
}

export function hasSufficientAuthority(user: AuthorityLevel, required: AuthorityLevel): boolean {
  return AUTHORITY_HIERARCHY[user] >= AUTHORITY_HIERARCHY[required]
}

export function isValidAuthority(value: string): value is AuthorityLevel {
  return Object.keys(AUTHORITY_HIERARCHY).includes(value)
}

export function assertValidAuthority(value: string): AuthorityLevel {
  if (!isValidAuthority(value)) {
    throw new Error(`Invalid authority level: "${value}". Must be one of: ${Object.keys(AUTHORITY_HIERARCHY).join(", ")}`)
  }
  return value
}

/** Aggregate version for optimistic concurrency. */
export type AggregateVersion = number

/** Identity types. */
export type TaskRunId = string & { readonly __brand: "TaskRunId" }
export type ContractFamilyId = string & { readonly __brand: "ContractFamilyId" }
export type ContractVersionId = string & { readonly __brand: "ContractVersionId" }
export type GateId = string & { readonly __brand: "GateId" }
export type CommitSha = string & { readonly __brand: "CommitSha" }
export type ActorId = string & { readonly __brand: "ActorId" }
export type CorrelationId = string & { readonly __brand: "CorrelationId" }
export type IdempotencyKey = string & { readonly __brand: "IdempotencyKey" }
export type EventId = string & { readonly __brand: "EventId" }

/** Completion failure codes. */
export type CompletionFailureCode =
  | "CURRENT_SHA_MISMATCH"
  | "ASSIGNMENTS_INCOMPLETE"
  | "CRITICAL_REQUIREMENTS_FAILED"
  | "CRITICAL_CRITERIA_FAILED"
  | "VERIFICATION_POLICY_FAILED"
  | "MANDATORY_EVIDENCE_MISSING"
  | "OVERRIDE_NOT_ALLOWED"
  | "OVERRIDE_INVALID"
  | "OVERRIDE_EXPIRED"
  | "OVERRIDE_ALREADY_CONSUMED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_REVOKED"
  | "INSUFFICIENT_AUTHORITY"
