import type { IncomingMessage, ServerResponse } from "http";
import { z } from "zod/v4";
import { OrchestrationError, ErrorCodes } from "../../types";

export function validateBody(schema: z.ZodTypeAny) {
  return (body: unknown): Record<string, unknown> => {
    const result = schema.safeParse(body);
    if (!result.success) {
      const issues = result.error.issues.map(i => ({ path: i.path.join("."), message: i.message }));
      throw OrchestrationError.fromCode(ErrorCodes.INVALID_INPUT, {
        message: "Invalid request body",
        details: { issues },
      });
    }
    return result.data as Record<string, unknown>;
  };
}

export function validateQuery(schema: z.ZodTypeAny) {
  return (query: Record<string, unknown>): Record<string, unknown> => {
    const result = schema.safeParse(query);
    if (!result.success) {
      const issues = result.error.issues.map(i => ({ path: i.path.join("."), message: i.message }));
      throw OrchestrationError.fromCode(ErrorCodes.INVALID_INPUT, {
        message: "Invalid query parameters",
        details: { issues },
      });
    }
    return result.data as Record<string, unknown>;
  };
}
