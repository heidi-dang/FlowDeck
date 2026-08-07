/**
 * Contracts sub-domain — public API barrel.
 *
 * Re-exports all domain types, services, policies, and ports
 * that are part of the stable public surface.
 */

// Domain
export {
  ContractFamily,
  ContractVersion,
  Specification,
  ContractDomainError,
  FamilyNotFoundError,
  VersionNotFoundError,
  DuplicateVersionError,
  InvalidSpecificationError,
  ActivationError,
  ImmutableContractError,
  IncompleteDraftError,
  CrossContractReferenceError,
  ContractHashError,
} from "./domain/index"

// Types — re-exported for convenience
export type {
  ContractVersionData,
  ContractFamilyData,
  ContractVersionStatus,
  SpecificationInput,
  Requirement,
  AcceptanceCriterion,
  VerificationRule,
  CriterionPriority,
  VerificationScope,
  FailureClass,
} from "./domain/index"

// TaskContract — structured task contract interfaces
export type {
  Requirement as TaskContractRequirement,
  AcceptanceCriterion as TaskContractAcceptanceCriterion,
  Constraint,
  EvidenceRequirement,
  VerificationRequirement,
  MutationScope,
  ApprovalGate,
  TaskContractStatus,
  TaskContract,
  TaskContractDraft,
  TaskContractValidationResult,
  ContractActivationResult,
} from "./task-contract"

// Contract hashing
export { hashContract, verifyContractHash } from "./contract-hasher"

// Contract validation
export {
  validateContractDraft,
  validateMutationScope,
  activateContract,
  validateActivatedContract,
} from "./contract-validator"

// Contract store
export { ContractStore, createContractStore, reconstructContractStore, type IContractStore } from "./contract-store"

// Hashing
export { hashSpecification } from "./hashing/specification-hash"

// Services
export { ContractService } from "./services/contract-service"
export { activateVersion } from "./services/activation-service"
export type { ActivateVersionInput, ActivationResult } from "./services/activation-service"
export type { CreateFamilyInput, DraftVersionInput, UpdateDraftInput } from "./services/contract-service"

// Policies
export { validateActivation } from "./policies/activation-policy"
export { isValidTransition, validateStatusTransition, validateImmutability } from "./policies/version-policy"

// Ports
export type { ContractRepository } from "./ports/contract-repository"

// Adapters
export { InMemoryContractRepository } from "./adapters/in-memory-contract-repository"
