/**
 * Domain errors for the verification sub-domain.
 */

export class VerificationDomainError extends Error {
  public readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "VerificationDomainError"
    this.code = code
  }
}

export class VerificationRunNotFoundError extends VerificationDomainError {
  constructor(runId: string) {
    super("VERIFICATION_RUN_NOT_FOUND", `Verification run not found: ${runId}`)
  }
}

export class VerificationResultNotFoundError extends VerificationDomainError {
  constructor(resultId: string) {
    super("VERIFICATION_RESULT_NOT_FOUND", `Verification result not found: ${resultId}`)
  }
}

export class StaleVerificationError extends VerificationDomainError {
  constructor(reason: string) {
    super("STALE_VERIFICATION", `Stale verification: ${reason}`)
  }
}

export class ShaMismatchError extends VerificationDomainError {
  constructor(expected: string, actual: string) {
    super("SHA_MISMATCH", `SHA mismatch: expected ${expected}, got ${actual}`)
  }
}

export class CrossRunReferenceError extends VerificationDomainError {
  constructor(reason: string) {
    super("CROSS_RUN_REFERENCE", `Cross-run reference not allowed: ${reason}`)
  }
}

export class ImmutableVerificationResultError extends VerificationDomainError {
  constructor(reason: string) {
    super("IMMUTABLE_VERIFICATION_RESULT", `Cannot modify verification result: ${reason}`)
  }
}
