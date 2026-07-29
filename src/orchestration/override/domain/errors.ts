export class OverrideDomainError extends Error {
  public readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "OverrideDomainError"
    this.code = code
  }
}
export class OverrideNotFoundError extends OverrideDomainError {
  constructor(id: string) { super("OVERRIDE_NOT_FOUND", `Override not found: ${id}`) }
}
export class OverrideNotApprovedError extends OverrideDomainError {
  constructor(id: string) { super("OVERRIDE_NOT_APPROVED", `Override ${id} is not approved`) }
}
export class OverrideExpiredError extends OverrideDomainError {
  constructor(id: string) { super("OVERRIDE_EXPIRED", `Override ${id} has expired`) }
}
export class OverrideConsumedError extends OverrideDomainError {
  constructor(id: string) { super("OVERRIDE_CONSUMED", `Override ${id} has already been consumed`) }
}
export class OverrideWrongRunError extends OverrideDomainError {
  constructor(expected: string, actual: string) {
    super("OVERRIDE_WRONG_RUN", `Override belongs to run ${actual}, expected ${expected}`)
  }
}
export class OverrideWrongShaError extends OverrideDomainError {
  constructor(expected: string, actual: string) {
    super("OVERRIDE_WRONG_SHA", `Override targets SHA ${actual}, expected ${expected}`)
  }
}
export class OverrideWrongGateError extends OverrideDomainError {
  constructor(gateId: string) { super("OVERRIDE_WRONG_GATE", `Override targets gate ${gateId}, which is not overridable`) }
}
export class NonOverridableGateError extends OverrideDomainError {
  constructor(gateId: string) { super("NON_OVERRIDABLE_GATE", `Gate ${gateId} cannot be overridden`) }
}
export class InsufficientOverrideAuthorityError extends OverrideDomainError {
  constructor(required: string, actual: string) {
    super("INSUFFICIENT_OVERRIDE_AUTHORITY", `Required ${required}, has ${actual}`)
  }
}
export class DuplicateActiveOverrideError extends OverrideDomainError {
  constructor(gateId: string) { super("DUPLICATE_ACTIVE_OVERRIDE", `An active override already exists for gate ${gateId}`) }
}
