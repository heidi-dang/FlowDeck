/**
 * Heidi Primary Execution Policy
 *
 * Defines execution strategies, justified delegation rules, the 6-stage
 * task lifecycle, pre-edit surface-area inspection, and bounded recovery.
 */

export type ExecutionStrategy =
  | "fast_direct"
  | "direct"
  | "explore_then_direct"
  | "planner_then_execute"
  | "debugger_root_cause"
  | "frontend_backend_parallel"
  | "audit_only"
  | "audit_after_change"

export const EXECUTION_STRATEGIES: readonly ExecutionStrategy[] = [
  "fast_direct",
  "direct",
  "explore_then_direct",
  "planner_then_execute",
  "debugger_root_cause",
  "frontend_backend_parallel",
  "audit_only",
  "audit_after_change",
] as const

export function isValidExecutionStrategy(val: unknown): val is ExecutionStrategy {
  return typeof val === "string" && (EXECUTION_STRATEGIES as readonly string[]).includes(val)
}

export type LifecycleStage =
  | "intake"
  | "route"
  | "context"
  | "execute"
  | "verify"
  | "complete"

export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  "intake",
  "route",
  "context",
  "execute",
  "verify",
  "complete",
] as const

export interface DelegationContext {
  /** User explicitly named/requested a specialist agent */
  explicitUserRequest?: boolean
  /** Subtasks have independent, non-overlapping file ownership */
  independentOwnership?: boolean
  /** Requires specialized domain expertise (e.g. security-auditor, devops) */
  specialistDomainRequired?: boolean
  /** Task is a read-only audit or security review */
  auditOrSecurityReview?: boolean
  /** Direct repository discovery/inspection failed */
  directDiscoveryFailed?: boolean
  /** Change spans multiple technical domains requiring coordinated ownership */
  multiDomainSpanning?: boolean
}

export interface DelegationJustificationResult {
  justified: boolean
  reasons: string[]
}

/**
 * Determine if delegation to a specialist agent is justified.
 * Delegation is permitted ONLY when at least one justification condition is true.
 * Merely having a specialist agent available does NOT justify delegation.
 */
export function evaluateDelegationJustification(
  ctx: DelegationContext
): DelegationJustificationResult {
  const reasons: string[] = []

  if (ctx.explicitUserRequest) {
    reasons.push("User explicitly requested a specialist agent")
  }
  if (ctx.independentOwnership) {
    reasons.push("Work can run independently on non-overlapping file ownership")
  }
  if (ctx.specialistDomainRequired) {
    reasons.push("Task requires specialist domain expertise")
  }
  if (ctx.auditOrSecurityReview) {
    reasons.push("Read-only audit or security review requested")
  }
  if (ctx.directDiscoveryFailed) {
    reasons.push("Direct repository discovery failed")
  }
  if (ctx.multiDomainSpanning) {
    reasons.push("Change spans multiple technical domains requiring coordinated ownership")
  }

  return {
    justified: reasons.length > 0,
    reasons,
  }
}

export interface SurfaceAreaCheckResult {
  dependents: string[]
  existingTests: string[]
  relatedConfig: string[]
  assumptions: string[]
  errorPaths: string[]
  readyForEdit: boolean
}

/**
 * Perform before-edit surface-area check.
 * Inspects callers/dependents, tests, config, and error paths before making changes.
 */
export function performSurfaceAreaCheck(input: {
  targetFiles: string[]
  knownDependents?: string[]
  knownTests?: string[]
  knownConfig?: string[]
  assumptions?: string[]
  errorPaths?: string[]
}): SurfaceAreaCheckResult {
  const dependents = input.knownDependents ?? []
  const existingTests = input.knownTests ?? []
  const relatedConfig = input.knownConfig ?? []
  const assumptions = input.assumptions ?? []
  const errorPaths = input.errorPaths ?? []

  return {
    dependents,
    existingTests,
    relatedConfig,
    assumptions,
    errorPaths,
    readyForEdit: input.targetFiles.length > 0,
  }
}

export interface FailureRecoveryState {
  errorKey: string
  attempts: number
  action: "targeted_diagnosis" | "change_hypothesis" | "circuit_breaker_block"
  message: string
}

/**
 * Bounded Recovery Tracker.
 * 1st failure -> targeted diagnosis
 * 2nd failure -> change hypothesis / strategy
 * 3rd failure -> circuit breaker block and exact report
 * Normal implementation tasks receive at most 1 automatic repair cycle.
 */
export class BoundedRecoveryTracker {
  private failureCounts: Map<string, number> = new Map()

  recordFailure(errorKey: string): FailureRecoveryState {
    const count = (this.failureCounts.get(errorKey) ?? 0) + 1
    this.failureCounts.set(errorKey, count)

    if (count === 1) {
      return {
        errorKey,
        attempts: 1,
        action: "targeted_diagnosis",
        message: `[Recovery 1/3] Failure detected for "${errorKey}". Performing targeted diagnosis on root cause.`,
      }
    }

    if (count === 2) {
      return {
        errorKey,
        attempts: 2,
        action: "change_hypothesis",
        message: `[Recovery 2/3] Equivalent failure repeated for "${errorKey}". Changing repair hypothesis or strategy.`,
      }
    }

    return {
      errorKey,
      attempts: count,
      action: "circuit_breaker_block",
      message: `[Recovery 3/3 Circuit Breaker] Task failed ${count} times on "${errorKey}". Stopping automatic retries and reporting exact root cause to user.`,
    }
  }

  getFailureCount(errorKey: string): number {
    return this.failureCounts.get(errorKey) ?? 0
  }

  reset(errorKey?: string): void {
    if (errorKey) {
      this.failureCounts.delete(errorKey)
    } else {
      this.failureCounts.clear()
    }
  }
}
