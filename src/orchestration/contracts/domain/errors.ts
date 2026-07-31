/**
 * Domain errors for the contracts sub-domain.
 * Every error includes a machine-readable code and a human-readable message.
 */

export class ContractDomainError extends Error {
  public readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "ContractDomainError"
    this.code = code
  }
}

export class FamilyNotFoundError extends ContractDomainError {
  constructor(familyId: string) {
    super("FAMILY_NOT_FOUND", `Contract family not found: ${familyId}`)
  }
}

export class VersionNotFoundError extends ContractDomainError {
  constructor(familyId: string, version: number) {
    super("VERSION_NOT_FOUND", `Version ${version} not found in family ${familyId}`)
  }
}

export class DuplicateVersionError extends ContractDomainError {
  constructor(familyId: string, version: number) {
    super("DUPLICATE_VERSION", `Version ${version} already exists in family ${familyId}`)
  }
}

export class InvalidSpecificationError extends ContractDomainError {
  constructor(reason: string) {
    super("INVALID_SPECIFICATION", `Invalid specification: ${reason}`)
  }
}

export class ActivationError extends ContractDomainError {
  constructor(reason: string) {
    super("ACTIVATION_FAILED", `Activation failed: ${reason}`)
  }
}

export class ImmutableContractError extends ContractDomainError {
  constructor(reason: string) {
    super("IMMUTABLE_CONTRACT", `Cannot modify activated contract: ${reason}`)
  }
}

export class IncompleteDraftError extends ContractDomainError {
  constructor(reason: string) {
    super("INCOMPLETE_DRAFT", `Draft is incomplete: ${reason}`)
  }
}

export class CrossContractReferenceError extends ContractDomainError {
  constructor(reason: string) {
    super("CROSS_CONTRACT_REFERENCE", `Cross-contract reference not allowed: ${reason}`)
  }
}

export class ContractHashError extends ContractDomainError {
  constructor(reason: string) {
    super("CONTRACT_HASH_ERROR", `Hash computation failed: ${reason}`)
  }
}
