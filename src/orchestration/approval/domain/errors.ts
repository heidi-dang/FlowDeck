export class ApprovalDomainError extends Error {
  public readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "ApprovalDomainError"
    this.code = code
  }
}
export class ApprovalNotFoundError extends ApprovalDomainError {
  constructor(id: string) { super("APPROVAL_NOT_FOUND", `Approval not found: ${id}`) }
}
export class InvalidApprovalError extends ApprovalDomainError {
  constructor(reason: string) { super("INVALID_APPROVAL", `Invalid approval: ${reason}`) }
}
export class InsufficientAuthorityError extends ApprovalDomainError {
  constructor(required: string, actual: string) {
    super("INSUFFICIENT_AUTHORITY", `Required authority ${required}, but has ${actual}`)
  }
}
export class ApprovalExpiredError extends ApprovalDomainError {
  constructor(id: string) { super("APPROVAL_EXPIRED", `Approval ${id} has expired`) }
}
export class ApprovalRevokedError extends ApprovalDomainError {
  constructor(id: string) { super("APPROVAL_REVOKED", `Approval ${id} has been revoked`) }
}
export class ApprovalRejectedError extends ApprovalDomainError {
  constructor(id: string) { super("APPROVAL_REJECTED", `Approval ${id} was rejected`) }
}
export class ApprovalWrongRunError extends ApprovalDomainError {
  constructor(expectedRunId: string, actualRunId: string) {
    super("APPROVAL_WRONG_RUN", `Approval belongs to run ${actualRunId}, expected ${expectedRunId}`)
  }
}
export class ApprovalWrongShaError extends ApprovalDomainError {
  constructor(expectedSha: string, actualSha: string) {
    super("APPROVAL_WRONG_SHA", `Approval targets SHA ${actualSha}, expected ${expectedSha}`)
  }
}
export class ApprovalWrongContractError extends ApprovalDomainError {
  constructor(expected: string, actual: string) {
    super("APPROVAL_WRONG_CONTRACT", `Approval targets contract ${actual}, expected ${expected}`)
  }
}
