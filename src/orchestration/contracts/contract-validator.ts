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
  MutationScope,
} from "./task-contract"
import { hashContract } from "./contract-hasher"
import { ContractStore } from "./contract-store"

/**
 * Validates a full SHA format (40 character hex for SHA-1, 64 character hex for SHA-256).
 * Rejects SHAs that are too short, too long, or contain invalid characters.
 */
function isValidSha(sha: string): boolean {
  return /^[a-f0-9]{40}$/.test(sha) || /^[a-f0-9]{64}$/.test(sha)
}

/**
 * Normalizes a path by resolving . and .. components.
 * Returns null if the path attempts to escape above the root directory.
 */
function normalizePath(path: string): string | null {
  // Split on slashes, filter out empty parts and handle .
  const parts = path.split(/[/\\]+/).filter((p) => p && p !== ".")
  const normalized: string[] = []

  for (const part of parts) {
    if (part === "..") {
      if (normalized.length === 0) {
        // Path tries to traverse above root
        return null
      }
      normalized.pop()
    } else {
      normalized.push(part)
    }
  }

  return "/" + normalized.join("/")
}

/**
 * Checks if a path contains traversal attempts or is otherwise suspicious.
 */
function isPathTraversalUnsafe(path: string): boolean {
  // Check for literal .. components
  if (path.includes("..")) return true
  // Check for URL-encoded traversal
  if (path.includes("%2e%2e") || path.includes("%252e")) return true
  // Check for absolute paths that escape repository
  if (path.startsWith("/etc/") || path.startsWith("/root/") || path.startsWith("/usr/")) return true
  return false
}

/**
 * Checks if a path is safe (normalized form exists and doesn't escape).
 */
function isPathSafe(path: string): boolean {
  if (isPathTraversalUnsafe(path)) return false
  const normalized = normalizePath(path)
  if (normalized === null) return false
  // Ensure path is absolute
  if (!normalized.startsWith("/")) return false
  return true
}

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
  } else if (!isValidSha(draft.startingSha)) {
    errors.push("Starting SHA must be a valid 40-character hex SHA-256 hash")
  }

  // Status validation - draft must have "draft" status
  if (draft.status !== "draft") {
    errors.push(`Draft contract must have status "draft", got "${draft.status}"`)
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

  const proposedPath = proposedChanges.path

  // Reject path traversal attempts
  if (!isPathSafe(proposedPath)) {
    return {
      valid: false,
      error: `Path "${proposedPath}" is not safe (traversal or escape attempt detected)`,
    }
  }

  // Normalize the proposed path for comparison
  const normalizedProposed = normalizePath(proposedPath)
  if (normalizedProposed === null) {
    return {
      valid: false,
      error: `Path "${proposedPath}" is not safe (traversal or escape attempt detected)`,
    }
  }

  // Check denied paths - normalize them too
  for (const path of scope.deniedPaths) {
    if (!isPathSafe(path)) {
      // Skip entries that are themselves unsafe (shouldn't be in config)
      continue
    }
    const normalizedDenied = normalizePath(path)
    if (normalizedDenied === null) continue
    if (normalizedProposed.startsWith(normalizedDenied)) {
      return {
        valid: false,
        error: `Path "${path}" is explicitly denied`,
      }
    }
  }

  // Check allowed paths (if specified) - normalize them
  if (scope.allowedPaths.length > 0) {
    const isAllowed = scope.allowedPaths.some((allowed) => {
      if (!isPathSafe(allowed)) return false
      const normalizedAllowed = normalizePath(allowed)
      if (normalizedAllowed === null) return false
      return normalizedProposed.startsWith(normalizedAllowed)
    })
    if (!isAllowed) {
      return {
        valid: false,
        error: `Path "${proposedPath}" is not in allowed paths`,
      }
    }
  }

  return { valid: true }
}

/**
 * Creates a deep frozen copy of an object, handling nested structures.
 */
function deepFreezeCopy<T extends object>(obj: T): Readonly<T> {
  if (obj === null || obj === undefined) return obj as Readonly<T>
  if (typeof obj !== "object") return obj as Readonly<T>

  // Handle Date - create frozen copy
  if (obj instanceof Date) {
    return Object.freeze(new Date(obj)) as unknown as Readonly<T>
  }

  // Handle Map
  if (obj instanceof Map) {
    const frozenMap = new Map()
    for (const [k, v] of obj.entries()) {
      frozenMap.set(deepFreezeCopy(k), deepFreezeCopy(v))
    }
    return Object.freeze(frozenMap) as unknown as Readonly<T>
  }

  // Handle Set
  if (obj instanceof Set) {
    const frozenSet = new Set()
    for (const value of obj.values()) {
      frozenSet.add(deepFreezeCopy(value))
    }
    return Object.freeze(frozenSet) as unknown as Readonly<T>
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return Object.freeze(obj.map((item) => deepFreezeCopy(item))) as unknown as Readonly<T>
  }

  // Handle plain objects - freeze each value recursively
  const result: Record<string, unknown> = {}
  const objRecord = obj as Record<string, unknown>
  for (const key of Object.keys(objRecord)) {
    result[key] = deepFreezeCopy(objRecord[key] as object)
  }
  return Object.freeze(result) as unknown as Readonly<T>
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

  // Create immutable activated contract with deep freezing
  // Use deep freeze copy to ensure all nested objects, arrays, Maps, Sets, Dates are frozen
  const contractData: TaskContract = deepFreezeCopy({
    ...draft,
    hash,
    status: "activated",
    activatedAt: new Date(),
  }) as TaskContract

  // Verify the contract is properly frozen
  if (!Object.isFrozen(contractData)) {
    throw new Error("Contract failed to freeze properly")
  }

  // Store immutably using withContract to get new store instance
  const updatedStore = store.withContract(contractData)

  return {
    success: true,
    contract: contractData,
    updatedStore,
  }
}

/**
 * Validates a complete contract (post-activation integrity check).
 */
export function validateActivatedContract(contract: TaskContract): TaskContractValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Verify status is valid
  if (!contract.status) {
    errors.push("Contract must have a status")
  } else if (contract.status !== "activated" && contract.status !== "completed" && contract.status !== "failed" && contract.status !== "superseded") {
    errors.push(`Invalid status: ${contract.status}`)
  }

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
    status: "draft",
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
