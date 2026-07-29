import type { IncomingMessage, ServerResponse } from "http";
import { OrchestrationError } from "../../types";
import type { RequestContext } from "./request-context";

export function errorHandler(
  err: unknown,
  _req: IncomingMessage,
  res: ServerResponse,
  ctx?: RequestContext,
): void {
  if (err instanceof OrchestrationError) {
    const response = err.toApiResponse();
    if (ctx?.correlationId) {
      (response.error as Record<string, unknown>).correlationId = ctx.correlationId;
    }
    res.writeHead(err.httpStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  // Unknown errors - never expose stack traces
  const message = process.env.NODE_ENV === "production" ? "Internal server error" : String(err);
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: {
      code: "UNEXPECTED_ERROR",
      message,
      category: "INTERNAL",
      correlationId: ctx?.correlationId,
      retryable: false,
    },
  }));
}
