export class IdempotencyError extends Error {
  public readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "IdempotencyError"
    this.code = code
  }
}
export class IdempotencyConflictError extends IdempotencyError {
  public readonly expectedHash: string
  public readonly actualHash: string
  constructor(key: string, expectedHash: string, actualHash: string) {
    super("IDEMPOTENCY_CONFLICT", `Idempotency key "${key}" used with different payload`)
    this.expectedHash = expectedHash
    this.actualHash = actualHash
  }
}
export class IdempotencyInProgressError extends IdempotencyError {
  constructor(key: string) {
    super("IDEMPOTENCY_IN_PROGRESS", `Command already in progress for key "${key}"`)
  }
}
export class IdempotencyIntegrityError extends IdempotencyError {
  constructor(key: string, detail: string) {
    super("IDEMPOTENCY_INTEGRITY", `Idempotency record "${key}" points to missing result: ${detail}`)
  }
}
