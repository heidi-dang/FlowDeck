/**
 * Domain errors for the completion sub-domain.
 */

export class CompletionDomainError extends Error {
  public readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "CompletionDomainError"
    this.code = code
  }
}

export class CompletionEvaluationError extends CompletionDomainError {
  constructor(reason: string) {
    super("COMPLETION_EVALUATION_ERROR", `Completion evaluation failed: ${reason}`)
  }
}

export class GateEvaluationError extends CompletionDomainError {
  constructor(gateId: string, reason: string) {
    super("GATE_EVALUATION_ERROR", `Gate ${gateId} evaluation failed: ${reason}`)
  }
}
