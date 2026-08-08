/**
 * Verification Plan System
 *
 * Barrel export for the verification plan system which provides
 * deterministic verification of contract implementations.
 */

export {
  VerificationExecutor,
  type ExecutorEvent,
} from "./verification-executor"

export {
  type VerificationPlan,
  type VerificationCheck,
  type VerificationCheckType,
  type Precondition,
  type PreconditionType,
  type ArtifactRequirement,
  type ArtifactRequirementType,
} from "./verification-plan"

export {
  type VerificationResult,
  type VerificationStatus,
  type CheckResult,
  type CheckStatus,
} from "./verification-result"
