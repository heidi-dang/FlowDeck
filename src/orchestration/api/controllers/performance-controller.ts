import type { IncomingMessage, ServerResponse } from "http"
import type { RequestContext } from "../middleware/request-context"
import { errorHandler } from "../middleware/error-handler"
import type { PerformanceProjection } from "../../services/performance-projection"
export function createPerformanceController(projection: PerformanceProjection) { return { async get(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, agentId: string, capability: string): Promise<void> { try { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: projection.get(agentId, capability) })) } catch (err) { errorHandler(err, req, res, ctx) } } } }
