import { z } from "zod/v4";

export const ErrorCategory = {
  VALIDATION: "VALIDATION",
  AUTHENTICATION: "AUTHENTICATION",
  AUTHORIZATION: "AUTHORIZATION",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  IDEMPOTENCY: "IDEMPOTENCY",
  RATE_LIMIT: "RATE_LIMIT",
  DEPENDENCY: "DEPENDENCY",
  INTERNAL: "INTERNAL",
  TIMEOUT: "TIMEOUT",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

export const ErrorCodes = {
  INVALID_INPUT: { code: "INVALID_INPUT", category: ErrorCategory.VALIDATION, httpStatus: 400, retryable: false },
  MISSING_REQUIRED_FIELD: { code: "MISSING_REQUIRED_FIELD", category: ErrorCategory.VALIDATION, httpStatus: 400, retryable: false },
  INVALID_FORMAT: { code: "INVALID_FORMAT", category: ErrorCategory.VALIDATION, httpStatus: 400, retryable: false },
  INVALID_RUN_STATUS: { code: "INVALID_RUN_STATUS", category: ErrorCategory.VALIDATION, httpStatus: 400, retryable: false },
  UNAUTHENTICATED: { code: "UNAUTHENTICATED", category: ErrorCategory.AUTHENTICATION, httpStatus: 401, retryable: false },
  FORBIDDEN: { code: "FORBIDDEN", category: ErrorCategory.AUTHORIZATION, httpStatus: 403, retryable: false },
  RUN_NOT_FOUND: { code: "RUN_NOT_FOUND", category: ErrorCategory.NOT_FOUND, httpStatus: 404, retryable: false },
  CONTRACT_NOT_FOUND: { code: "CONTRACT_NOT_FOUND", category: ErrorCategory.NOT_FOUND, httpStatus: 404, retryable: false },
  ASSIGNMENT_NOT_FOUND: { code: "ASSIGNMENT_NOT_FOUND", category: ErrorCategory.NOT_FOUND, httpStatus: 404, retryable: false },
  SESSION_NOT_FOUND: { code: "SESSION_NOT_FOUND", category: ErrorCategory.NOT_FOUND, httpStatus: 404, retryable: false },
  EVENT_NOT_FOUND: { code: "EVENT_NOT_FOUND", category: ErrorCategory.NOT_FOUND, httpStatus: 404, retryable: false },
  ENTITY_NOT_FOUND: { code: "ENTITY_NOT_FOUND", category: ErrorCategory.NOT_FOUND, httpStatus: 404, retryable: false },
  VERIFICATION_NOT_FOUND: { code: "VERIFICATION_NOT_FOUND", category: ErrorCategory.NOT_FOUND, httpStatus: 404, retryable: false },
  RUN_ALREADY_EXISTS: { code: "RUN_ALREADY_EXISTS", category: ErrorCategory.CONFLICT, httpStatus: 409, retryable: false },
  CONTRACT_ALREADY_EXISTS: { code: "CONTRACT_ALREADY_EXISTS", category: ErrorCategory.CONFLICT, httpStatus: 409, retryable: false },
  RUN_IN_TERMINAL_STATE: { code: "RUN_IN_TERMINAL_STATE", category: ErrorCategory.CONFLICT, httpStatus: 409, retryable: false },
  SEMANTIC_SATURATED: { code: "SEMANTIC_SATURATED", category: ErrorCategory.CONFLICT, httpStatus: 409, retryable: false },
  DUPLICATE_REQUEST: { code: "DUPLICATE_REQUEST", category: ErrorCategory.IDEMPOTENCY, httpStatus: 409, retryable: false },
  DEPENDENCY_FAILURE: { code: "DEPENDENCY_FAILURE", category: ErrorCategory.DEPENDENCY, httpStatus: 502, retryable: true },
  DATABASE_UNAVAILABLE: { code: "DATABASE_UNAVAILABLE", category: ErrorCategory.DEPENDENCY, httpStatus: 503, retryable: true },
  STREAM_UNAVAILABLE: { code: "STREAM_UNAVAILABLE", category: ErrorCategory.DEPENDENCY, httpStatus: 503, retryable: true },
  INTERNAL_ERROR: { code: "INTERNAL_ERROR", category: ErrorCategory.INTERNAL, httpStatus: 500, retryable: false },
  UNSUPPORTED_CAPABILITY: { code: "UNSUPPORTED_CAPABILITY", category: ErrorCategory.INTERNAL, httpStatus: 501, retryable: false },
  REPLAY_NOT_CONFIGURED: { code: "REPLAY_NOT_CONFIGURED", category: ErrorCategory.INTERNAL, httpStatus: 501, retryable: false },
  REPLAY_IN_PROGRESS: { code: "REPLAY_IN_PROGRESS", category: ErrorCategory.CONFLICT, httpStatus: 409, retryable: false },
  REPLAY_STREAM_INVALID: { code: "REPLAY_STREAM_INVALID", category: ErrorCategory.VALIDATION, httpStatus: 400, retryable: false },
  COMPLETION_DECISION_IMMUTABLE: { code: "COMPLETION_DECISION_IMMUTABLE", category: ErrorCategory.CONFLICT, httpStatus: 409, retryable: false },
  VERIFICATION_RESULT_IMMUTABLE: { code: "VERIFICATION_RESULT_IMMUTABLE", category: ErrorCategory.CONFLICT, httpStatus: 409, retryable: false },
  RUN_STATUS_TRANSITION_INVALID: { code: "RUN_STATUS_TRANSITION_INVALID", category: ErrorCategory.CONFLICT, httpStatus: 409, retryable: false },
  ASSIGNMENT_RESULT_PERSISTENCE_NOT_CONFIGURED: { code: "ASSIGNMENT_RESULT_PERSISTENCE_NOT_CONFIGURED", category: ErrorCategory.INTERNAL, httpStatus: 501, retryable: false },
  ASSIGNMENT_METADATA_PERSISTENCE_NOT_CONFIGURED: { code: "ASSIGNMENT_METADATA_PERSISTENCE_NOT_CONFIGURED", category: ErrorCategory.INTERNAL, httpStatus: 501, retryable: false },
} as const;

export interface OrchestrationErrorOptions {
  code: string; message: string; category: ErrorCategory;
  correlationId?: string; retryable: boolean;
  suggestedAction?: string; details?: Record<string, unknown>; cause?: Error;
}

export class OrchestrationError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly correlationId?: string;
  public readonly retryable: boolean;
  public readonly suggestedAction?: string;
  public readonly details?: Record<string, unknown>;
  public readonly cause?: Error;
  public readonly httpStatus: number;

  constructor(opts: OrchestrationErrorOptions) {
    super(opts.message);
    this.name = "OrchestrationError";
    this.code = opts.code;
    this.category = opts.category;
    this.correlationId = opts.correlationId;
    this.retryable = opts.retryable;
    this.suggestedAction = opts.suggestedAction;
    this.details = opts.details;
    this.cause = opts.cause;
    const known = Object.values(ErrorCodes).find((e) => e.code === opts.code);
    this.httpStatus = known?.httpStatus ?? 500;
  }

  toJSON(): Record<string, unknown> {
    return { error: { code: this.code, message: this.message, category: this.category, correlationId: this.correlationId, retryable: this.retryable, suggestedAction: this.suggestedAction, ...(this.details ? { details: this.details } : {}) } };
  }

  toApiResponse(): Record<string, unknown> {
    return { error: { code: this.code, message: this.message, category: this.category, correlationId: this.correlationId, retryable: this.retryable, suggestedAction: this.suggestedAction } };
  }

  static fromCode(errorCode: typeof ErrorCodes[keyof typeof ErrorCodes], opts?: Partial<OrchestrationErrorOptions>): OrchestrationError {
    return new OrchestrationError({
      code: errorCode.code, message: opts?.message ?? errorCode.code,
      category: errorCode.category, retryable: errorCode.retryable,
      suggestedAction: opts?.suggestedAction, correlationId: opts?.correlationId,
      details: opts?.details, cause: opts?.cause,
    });
  }
}

/**
 * Exhaustive type guard — use in default branches of switch statements over
 * union types to ensure the compiler catches addition of new variants.
 */
export function assertNever(value: never, message?: string): never {
  throw new OrchestrationError(
    { code: "INTERNAL_ERROR", message: message ?? `Unhandled case: ${value}`, category: ErrorCategory.INTERNAL, retryable: false },
  );
}

export const ApiErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), category: z.string(), correlationId: z.string().optional(), retryable: z.boolean(), suggestedAction: z.string().optional() }),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
