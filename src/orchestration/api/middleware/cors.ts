import type { IncomingMessage, ServerResponse } from "http";

export function corsMiddleware(allowedOrigins?: string[]) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const origin = req.headers["origin"] ?? "*";
    res.setHeader("Access-Control-Allow-Origin", allowedOrigins?.includes(origin as string) ? origin : "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Correlation-Id, X-Idempotency-Key");
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    next();
  };
}
