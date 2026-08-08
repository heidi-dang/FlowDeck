/**
 * Verification Plan System
 *
 * Defines verification plans that capture the exact requirements for
 * validating a contract implementation. Plans are immutable once created
 * and include embedded SHA requirements for deterministic verification.
 */

export type VerificationCheckType =
  | "test"
  | "build"
  | "lint"
  | "typecheck"
  | "command"
  | "file"
  | "sha"

export interface VerificationCheck {
  readonly id: string
  readonly type: VerificationCheckType
  readonly command?: string
  readonly expectedExitCode?: number
  readonly timeout?: number
  readonly critical: boolean
  readonly order: number
}

export type PreconditionType =
  | "file_exists"
  | "dir_exists"
  | "sha_match"
  | "env_set"

export interface Precondition {
  readonly type: PreconditionType
  readonly path?: string
  readonly expected?: string
  readonly expectedSha?: string
  readonly envKey?: string
}

export type ArtifactRequirementType = "required" | "optional"

export interface ArtifactRequirement {
  readonly type: ArtifactRequirementType
  readonly path: string
  readonly description: string
}

export interface VerificationPlan {
  readonly id: string
  readonly contractId: string
  readonly version: string
  readonly runId: string
  readonly targetSha: string
  readonly checks: VerificationCheck[]
  readonly preconditions: Precondition[]
  readonly artifacts: ArtifactRequirement[]
  readonly createdAt: Date
  readonly hash: string
  readonly timeoutMs: number
  readonly parallel: boolean
}
