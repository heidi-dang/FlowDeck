/**
 * Structured Task Contract interfaces.
 *
 * A TaskContract is an immutable runtime artifact that formalizes the agreement
 * between a model-proposed contract and the runtime that validates and activates it.
 * Once activated, the contract is frozen and cannot be mutated.
 */

import type { ContractStore } from "./contract-store"

/**
 * Terminal states - once reached, the contract cannot transition back to active states.
 */
export const TERMINAL_STATUSES = new Set<TaskContractStatus>(["completed", "failed", "superseded"])

/**
 * Active states - the contract is still in progress.
 */
export const ACTIVE_STATUSES = new Set<TaskContractStatus>(["draft", "activated"])

/**
 * Validates that a status transition is valid.
 * Terminal states cannot transition back to active states.
 */
export function isValidStatusTransition(
  from: TaskContractStatus,
  to: TaskContractStatus
): boolean {
  // Can't go from terminal to active
  if (TERMINAL_STATUSES.has(from) && ACTIVE_STATUSES.has(to)) {
    return false
  }
  // Can't transition from draft to completed/failed directly without going through activated
  if (from === "draft" && (to === "completed" || to === "failed")) {
    return false
  }
  return true
}

/**
 * Checks if a status is terminal.
 */
export function isTerminalStatus(status: TaskContractStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export interface Requirement {
  readonly id: string
  readonly description: string
  readonly critical: boolean
  readonly verifiable: boolean
}

export interface AcceptanceCriterion {
  readonly id: string
  readonly description: string
  readonly critical: boolean
  readonly testable: boolean
}

export interface Constraint {
  readonly id: string
  readonly description: string
  readonly enforce: boolean
}

export interface EvidenceRequirement {
  readonly type: "file" | "test" | "output" | "log"
  readonly path?: string
  readonly description: string
}

export interface VerificationRequirement {
  readonly type: "test" | "build" | "lint" | "typecheck" | "custom"
  readonly command?: string
  readonly description: string
}

export interface MutationScope {
  readonly allowedPaths: readonly string[]
  readonly deniedPaths: readonly string[]
  readonly maxFiles: number
}

export interface ApprovalGate {
  readonly type: "automatic" | "manual"
  readonly authority?: string
}

export type TaskContractStatus = "draft" | "activated" | "completed" | "failed" | "superseded"

export interface TaskContract {
  readonly id: string
  readonly version: string
  readonly objective: string
  readonly requirements: readonly Requirement[]
  readonly acceptanceCriteria: readonly AcceptanceCriterion[]
  readonly constraints: readonly Constraint[]
  readonly exclusions: readonly string[]
  readonly requiredEvidence: readonly EvidenceRequirement[]
  readonly requiredVerification: readonly VerificationRequirement[]
  readonly startingSha: string
  readonly allowedMutationScope: MutationScope
  readonly approvalGates: readonly ApprovalGate[]
  readonly createdAt: Date
  readonly activatedAt?: Date
  readonly status: TaskContractStatus
  readonly hash: string
}

export interface TaskContractDraft {
  readonly id: string
  readonly version: string
  readonly objective: string
  readonly requirements: readonly Requirement[]
  readonly acceptanceCriteria: readonly AcceptanceCriterion[]
  readonly constraints: readonly Constraint[]
  readonly exclusions: readonly string[]
  readonly requiredEvidence: readonly EvidenceRequirement[]
  readonly requiredVerification: readonly VerificationRequirement[]
  readonly startingSha: string
  readonly allowedMutationScope: MutationScope
  readonly approvalGates: readonly ApprovalGate[]
  readonly createdAt: Date
  /**
   * Draft status - required to be "draft" for a valid draft.
   */
  readonly status: "draft"
}

export interface TaskContractValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

export interface ContractActivationResult {
  readonly success: boolean
  readonly contract?: TaskContract
  readonly updatedStore?: ContractStore
  readonly error?: string
}
