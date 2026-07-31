import type { IncomingMessage, ServerResponse } from "http";
import type { HealthService } from "../../services/health-service";
import type { DiagnosticsService } from "../../diagnostics";
import { createHealthController } from "../controllers/health-controller";
import { extractRequestContext, attachContextToResponse } from "../middleware/request-context";
import { errorHandler } from "../middleware/error-handler";
import type { RequestContext } from "../middleware/request-context";

type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: RequestContext, ...params: string[]) => Promise<void>;

interface Route { method: string; pattern: RegExp; params: string[]; handler: RouteHandler; }

function createRouter() {
  const routes: Route[] = [];
  return {
    routes,
    add(method: string, path: string, handler: RouteHandler) {
      const paramNames: string[] = [];
      const patternStr = path.replace(/:([^/]+)/g, (_, name) => { paramNames.push(name); return "([^/]+)"; });
      routes.push({ method, pattern: new RegExp(`^${patternStr}$`), params: paramNames, handler });
    },
    async resolve(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;
      const ctx = extractRequestContext(req);
      attachContextToResponse(res, ctx);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = path.match(route.pattern);
        if (match) {
          const params = match.slice(1);
          try { await route.handler(req, res, ctx, ...params); } catch (err) { errorHandler(err, req, res, ctx); }
          return;
        }
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: `No route matches ${req.method} ${path}`, category: "NOT_FOUND", retryable: false } }));
    },
  };
}

export function createHealthRouter(healthService: HealthService, diagnosticsService?: DiagnosticsService) {
  const router = createRouter();
  const base = "/api/v1/orchestration";
  const ctrl = createHealthController(healthService, diagnosticsService);

  router.add("GET", `${base}/health`, (req, res, ctx) => ctrl.health(req, res, ctx));
  router.add("GET", `${base}/health/readiness`, (req, res, ctx) => ctrl.readiness(req, res, ctx));
  router.add("GET", `${base}/health/liveness`, (req, res, ctx) => ctrl.liveness(req, res, ctx));
  router.add("GET", `${base}/diagnostics`, (req, res, ctx) => ctrl.diagnostics(req, res, ctx));

  return router;
}
