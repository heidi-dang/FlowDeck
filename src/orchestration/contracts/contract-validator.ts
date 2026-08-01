/**
 * Runtime validation for TaskContracts.
 *
 * Validates contract completeness before activation.
 * Checks all required fields are present and meet invariants.
 * Activates immutable contracts upon successful validation.
 */

import type {
  TaskContract,
  TaskContractDraft,
  TaskContractValidationResult,
  ContractActivationResult,
  Requirement,
  AcceptanceCriterion,
  Constraint,
  EvidenceRequirement,
  VerificationRequirement,
  MutationScope,
  ApprovalGate,
} from "./task-contract"
import { hashContract } from "./contract-hasher"
import { ContractStore } from "./contract-store"

/**
 * Validates that a contract draft has all required fields and meets invariants.
 */
export function validateContractDraft(draft: TaskContractDraft): TaskContractValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Required string fields
  if (!draft.id || draft.id.trim() === "") {
    errors.push("Contract ID is required")
  }

  if (!draft.version || draft.version.trim() === "") {
    errors.push("Contract version is required")
  }

  if (!draft.objective || draft.objective.trim() === "") {
    errors.push("Contract objective is required")
  }

  if (!draft.startingSha || draft.startingSha.trim() === "") {
    errors.push("Starting SHA is required")
  }

  // Requirements validation
  if (!draft.requirements || draft.requirements.length === 0) {
    errors.push("At least one requirement is required")
  } else {
    for (const req of draft.requirements) {
      if (!req.id) errors.push("Requirement missing ID")
      if (!req.description || req.description.trim() === "") {
        errors.push(`Requirement ${req.id || "(unknown)"} missing description`)
      }
    }
  }

  // Acceptance criteria validation
  if (!draft.acceptanceCriteria || draft.acceptanceCriteria.length === 0) {
    errors.push("At least one acceptance criterion is required")
  } else {
    for (const criterion of draft.acceptanceCriteria) {
      if (!criterion.id) errors.push("Acceptance criterion missing ID")
      if (!criterion.description || criterion.description.trim() === "") {
        errors.push(`Acceptance criterion ${criterion.id || "(unknown)"} missing description`)
      }
    }
  }

  // Constraints validation
  if (!draft.constraints || draft.constraints.length === 0) {
    warnings.push("No constraints defined - consider adding at least one constraint")
  } else {
    for (const constraint of draft.constraints) {
      if (!constraint.id) errors.push("Constraint missing ID")
      if (!constraint.description || constraint.description.trim() === "") {
        errors.push(`Constraint ${constraint.id || "(unknown)"} missing description`)
      }
    }
  }

  // Exclusions - optional but should be explicitly empty or populated
  if (!draft.exclusions) {
    warnings.push("Exclusions not specified - consider explicitly listing scope boundaries")
  }

  // Required evidence validation
  if (!draft.requiredEvidence || draft.requiredEvidence.length === 0) {
    warnings.push("No evidence requirements specified")
  } else {
    for (const evidence of draft.requiredEvidence) {
      if (!evidence.type) errors.push(`Evidence requirement missing type`)
      if (!evidence.description || evidence.description.trim() === "") {
        errors.push(`Evidence requirement missing description`)
      }
      if (evidence.type === "file" && !evidence.path) {
        errors.push(`File evidence requirement must specify path`)
      }
    }
  }

  // Required verification validation
  if (!draft.requiredVerification || draft.requiredVerification.length === 0) {
    warnings.push("No verification requirements specified")
  } else {
    for (const verification of draft.requiredVerification) {
      if (!verification.type) errors.push(`Verification requirement missing type`)
      if (!verification.description || verification.description.trim() === "") {
        errors.push(`Verification requirement missing description`)
      }
      if (verification.type === "custom" && !verification.command) {
        errors.push(`Custom verification must specify command`)
      }
    }
  }

  // Mutation scope validation
  if (!draft.allowedMutationScope) {
    errors.push("Allowed mutation scope is required")
  } else {
    const scope = draft.allowedMutationScope
    if (!scope.allowedPaths || scope.allowedPaths.length === 0) {
      warnings.push("No allowed paths specified - all paths will be denied")
    }
    if (scope.maxFiles <= 0) {
      errors.push("maxFiles must be positive")
    }
  }

  // Approval gates validation
  if (!draft.approvalGates || draft.approvalGates.length === 0) {
    errors.push("At least one approval gate is required")
  } else {
    for (const gate of draft.approvalGates) {
      if (!gate.type) errors.push("Approval gate missing type")
      if (gate.type === "manual" && !gate.authority) {
        warnings.push("Manual approval gate should specify authority")
      }
    }
  }

  // Created at validation
  if (!draft.createdAt || isNaN(draft.createdAt.getTime())) {
    errors.push("Valid createdAt date is required")
  }

  return {
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  }
}

/**
 * Validates mutation scope constraints.
 */
export function validateMutationScope(
  scope: MutationScope,
  proposedChanges: { path: string; fileCount: number }
): { valid: boolean; error?: string } {
  // Check file count limit
  if (proposedChanges.fileCount > scope.maxFiles) {
    return {
      valid: false,
      error: `File count ${proposedChanges.fileCount} exceeds maximum ${scope.maxFiles}`,
    }
  }

  // Check path permissions
  for (const path of scope.deniedPaths) {
    if (proposedChanges.path.startsWith(path)) {
      return {
        valid: false,
        error: `Path ${path} is explicitly denied`,
      }
    }
  }

  // Check allowed paths (if specified)
  if (scope.allowedPaths.length > 0) {
    const isAllowed = scope.allowedPaths.some((allowed) => proposedChanges.path.startsWith(allowed))
    if (!isAllowed) {
      return {
        valid: false,
        error: `Path ${proposedChanges.path} is not in allowed paths`,
      }
    }
  }

  return { valid: true }
}

/**
 * Activates a contract if validation passes and store is available.
 * Returns an activated immutable contract.
 */
export function activateContract(
  draft: TaskContractDraft,
  store: ContractStore
): ContractActivationResult {
  // Validate completeness
  const validation = validateContractDraft(draft)
  if (!validation.valid) {
    return {
      success: false,
      error: `Validation failed: ${validation.errors.join("; ")}`,
    }
  }

  // Check for existing activation conflict
  const existing = store.getById(draft.id)
  if (existing && existing.activatedAt) {
    return {
      success: false,
      error: `Contract ${draft.id} is already activated`,
    }
  }

  // Compute deterministic hash
  const hash = hashContract(draft)

  // Deep freeze helper - freezes object and all nested arrays/objects
  function deepFreeze<T>(obj: T): Readonly<T> {
    if (obj === null || obj === undefined) return obj as Readonly<T>
    if (typeof obj !== "object") return obj as Readonly<T>

    if (Array.isArray(obj)) {
      Object.freeze(obj)
      for (const item of obj) {
        deepFreeze(item)
      }
      return Object.freeze([...obj]) as unknown as Readonly<T>
    }

    Object.freeze(obj)
    for (const key of Object.keys(obj as object)) {
      deepFreeze((obj as Record<string, unknown>)[key])
    }
    return obj as Readonly<T>
  }

  // Create immutable activated contract with deep freezing
  const contractData = {
    ...draft,
    hash,
    activatedAt: new Date(),
  }

  const contract: TaskContract = deepFreeze(contractData)

  // Store immutably using withContract to get new store instance
  const updatedStore = store.withContract(contract)

  return {
    success: true,
    contract,
    updatedStore,
  }
}

/**
 * Validates a complete contract (post-activation integrity check).
 */
export function validateActivatedContract(contract: TaskContract): TaskContractValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Verify hash integrity
  const draft: TaskContractDraft = {
    id: contract.id,
    version: contract.version,
    objective: contract.objective,
    requirements: contract.requirements,
    acceptanceCriteria: contract.acceptanceCriteria,
    constraints: contract.constraints,
    exclusions: contract.exclusions,
    requiredEvidence: contract.requiredEvidence,
    requiredVerification: contract.requiredVerification,
    startingSha: contract.startingSha,
    allowedMutationScope: contract.allowedMutationScope,
    approvalGates: contract.approvalGates,
    createdAt: contract.createdAt,
  }

  const expectedHash = hashContract(draft)
  if (contract.hash !== expectedHash) {
    errors.push(`Hash mismatch: contract content has been tampered with`)
  }

  // Verify activation timestamp
  if (!contract.activatedAt) {
    errors.push("Activated contract must have activatedAt timestamp")
  }

  // Run standard validation
  const baseValidation = validateContractDraft(draft)
  errors.push(...baseValidation.errors)
  warnings.push(...baseValidation.warnings)

  return {
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  }
}
