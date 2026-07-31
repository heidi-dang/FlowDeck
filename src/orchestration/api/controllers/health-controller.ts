import type { IncomingMessage, ServerResponse } from "http";
import type { HealthService } from "../../services/health-service";
import type { DiagnosticsService } from "../../diagnostics";
import { errorHandler } from "../middleware/error-handler";
import type { RequestContext } from "../middleware/request-context";

export function createHealthController(
  healthService: HealthService,
  diagnosticsService?: DiagnosticsService,
) {
  return {
    async health(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const status = await healthService.checkHealth();
        const accept = req.headers["accept"] ?? "";
        if (accept.includes("text/plain")) {
          const lines = status.checks.map(c => `${c.name}: ${c.status}${c.message ? ` - ${c.message}` : ""}`);
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(lines.join("\n") + `\n\noverall: ${status.status}\nuptime: ${status.uptime}ms\n`);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(status));
        }
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async readiness(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const status = await healthService.checkReadiness();
        const ready = status.status === "healthy";
        res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ready, status }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async liveness(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const status = await healthService.checkLiveness();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async diagnostics(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        if (!diagnosticsService) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Diagnostics not available" }));
          return;
        }
        const report = await diagnosticsService.generateReport();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(report));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },
  };
}
