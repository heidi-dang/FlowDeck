import type { IncomingMessage, ServerResponse } from "http";
import type { RunService } from "../../services/run-service";
import type { ContractService } from "../../services/contract-service";
import type { AssignmentService } from "../../services/assignment-service";
import type { VerificationService } from "../../services/verification-service";
import type { CompletionService } from "../../services/completion-service";
import type { ReplayService } from "../../services/replay-service";
import type { EventService } from "../../services/event-service";
import type { HealthService } from "../../services/health-service";
import type { RoutingProjection } from "../../services/routing-projection";
import { createRunController } from "../controllers/run-controller";
import { createContractController } from "../controllers/contract-controller";
import { createAssignmentController } from "../controllers/assignment-controller";
import { createVerificationController } from "../controllers/verification-controller";
import { createCompletionController } from "../controllers/completion-controller";
import { createReplayController } from "../controllers/replay-controller";
import { createEventController } from "../controllers/event-controller";
import { createRoutingController } from "../controllers/routing-controller";
import { extractRequestContext, attachContextToResponse } from "../middleware/request-context";
import { errorHandler } from "../middleware/error-handler";
import type { RequestContext } from "../middleware/request-context";

// ── Simple router ─────────────────────────────────────────────────────────

type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: RequestContext, ...params: string[]) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  params: string[];
  handler: RouteHandler;
}

function createRouter(): { routes: Route[]; add: (method: string, path: string, handler: RouteHandler) => void; resolve: (req: IncomingMessage, res: ServerResponse) => Promise<void> } {
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
          try {
            await route.handler(req, res, ctx, ...params);
          } catch (err) {
            errorHandler(err, req, res, ctx);
          }
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: `No route matches ${req.method} ${path}`, category: "NOT_FOUND", retryable: false } }));
    },
  };
}

// ── Route registration factory ────────────────────────────────────────────

export function createRouterWithControllers(deps: {
  runService: RunService;
  contractService: ContractService;
  assignmentService: AssignmentService;
  verificationService: VerificationService;
  completionService: CompletionService;
  replayService: ReplayService;
  eventService: EventService;
  healthService: HealthService;
  routingProjection: RoutingProjection;
}) {
  const router = createRouter();
  const base = "/api/v1/orchestration";

  const runCtrl = createRunController(deps.runService);
  const contractCtrl = createContractController(deps.contractService);
  const assignmentCtrl = createAssignmentController(deps.assignmentService);
  const verificationCtrl = createVerificationController(deps.verificationService);
  const completionCtrl = createCompletionController(deps.completionService);
  const replayCtrl = createReplayController(deps.replayService);
  const eventCtrl = createEventController(deps.eventService);
  const routingCtrl = createRoutingController(deps.routingProjection);

  // Run routes
  router.add("POST", `${base}/runs`, (req, res, ctx) => runCtrl.create(req, res, ctx));
  router.add("GET", `${base}/runs`, (req, res, ctx) => runCtrl.list(req, res, ctx));
  router.add("GET", `${base}/runs/:id`, (req, res, ctx, id) => runCtrl.get(req, res, ctx, id));
  router.add("GET", `${base}/runs/:id/routing`, (req, res, ctx, id) => routingCtrl.get(req, res, ctx, id));
  router.add("PATCH", `${base}/runs/:id`, (req, res, ctx, id) => runCtrl.update(req, res, ctx, id));
  router.add("POST", `${base}/runs/:id/cancel`, (req, res, ctx, id) => runCtrl.cancel(req, res, ctx, id));
  router.add("POST", `${base}/runs/:id/pause`, (req, res, ctx, id) => runCtrl.pause(req, res, ctx, id));

  // Contract routes
  router.add("POST", `${base}/contracts`, (req, res, ctx) => contractCtrl.create(req, res, ctx));
  router.add("GET", `${base}/contracts`, (req, res, ctx) => contractCtrl.list(req, res, ctx));
  router.add("GET", `${base}/contracts/:id`, (req, res, ctx, id) => contractCtrl.get(req, res, ctx, id));
  router.add("PATCH", `${base}/contracts/:id`, (req, res, ctx, id) => contractCtrl.update(req, res, ctx, id));

  // Assignment routes
  router.add("POST", `${base}/assignments`, (req, res, ctx) => assignmentCtrl.create(req, res, ctx));
  router.add("GET", `${base}/assignments`, (req, res, ctx) => assignmentCtrl.list(req, res, ctx));
  router.add("GET", `${base}/assignments/:id`, (req, res, ctx, id) => assignmentCtrl.get(req, res, ctx, id));
  router.add("PATCH", `${base}/assignments/:id`, (req, res, ctx, id) => assignmentCtrl.update(req, res, ctx, id));

  // Event routes
  router.add("GET", `${base}/events`, (req, res, ctx) => eventCtrl.list(req, res, ctx));
  router.add("GET", `${base}/events/:id`, (req, res, ctx, id) => eventCtrl.get(req, res, ctx, id));

  // Verification routes
  router.add("GET", `${base}/verification`, (req, res, ctx) => verificationCtrl.list(req, res, ctx));
  router.add("GET", `${base}/verification/:id`, (req, res, ctx, id) => verificationCtrl.get(req, res, ctx, id));
  router.add("GET", `${base}/verification/evidence`, (req, res, ctx) => verificationCtrl.listEvidence(req, res, ctx, ""));
  router.add("GET", `${base}/verification/evidence/:id`, (req, res, ctx, id) => verificationCtrl.listEvidence(req, res, ctx, id));

  // Completion routes
  router.add("POST", `${base}/completion`, (req, res, ctx) => completionCtrl.create(req, res, ctx));
  router.add("GET", `${base}/completion/:id`, (req, res, ctx, id) => completionCtrl.get(req, res, ctx, id));
  router.add("POST", `${base}/completion/:id/finalize`, (req, res, ctx, id) => completionCtrl.finalize(req, res, ctx, id));

  // Replay routes
  router.add("POST", `${base}/replay`, (req, res, ctx) => replayCtrl.create(req, res, ctx));
  router.add("GET", `${base}/replay`, (req, res, ctx) => replayCtrl.list(req, res, ctx));
  router.add("GET", `${base}/replay/:id`, (req, res, ctx, id) => replayCtrl.get(req, res, ctx, id));

  return router;
}
