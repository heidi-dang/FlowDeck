import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

export interface RequestContext {
  requestId: string;
  correlationId: string;
  causationId?: string;
  method: string;
  url: string;
  startTime: number;
}

export function extractRequestContext(req: IncomingMessage): RequestContext {
  const correlationId = (req.headers["x-correlation-id"] as string) ?? randomUUID();
  const causationId = req.headers["x-causation-id"] as string | undefined;
  return {
    requestId: randomUUID(),
    correlationId,
    causationId,
    method: req.method ?? "GET",
    url: req.url ?? "/",
    startTime: Date.now(),
  };
}

export function attachContextToResponse(res: ServerResponse, ctx: RequestContext): void {
  res.setHeader("X-Request-Id", ctx.requestId);
  res.setHeader("X-Correlation-Id", ctx.correlationId);
}
