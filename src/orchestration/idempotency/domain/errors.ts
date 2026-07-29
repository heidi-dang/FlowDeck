export class IdempotencyError extends Error {
  public readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "IdempotencyError"
    this.code = code
  }
}
export class IdempotencyConflictError extends IdempotencyError {
  constructor(key: string, expectedHash: string, actualHash: string) {
    super("IDEMPOTENCY_CONFLICT",
      `Idempotency key "${key}" used with different payload (hash ${actualHash}, expected ${expectedHash})`)
  }
}
export class IdempotencyKeyNotFoundError extends IdempotencyError {
  constructor(key: string) { super("IDEMPOTENCY_KEY_NOT_FOUND", `Idempotency key not found: ${key}`) }
}
