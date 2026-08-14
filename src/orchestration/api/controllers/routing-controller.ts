import type { IncomingMessage, ServerResponse } from "http"
import type { RequestContext } from "../middleware/request-context"
import { errorHandler } from "../middleware/error-handler"
import type { RoutingProjection } from "../../services/routing-projection"

export function createRoutingController(projection: RoutingProjection) {
  return { async get(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, runId: string): Promise<void> {
    try {
      const data = await projection.getForRun(runId)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data }))
    } catch (err) { errorHandler(err, req, res, ctx) }
  } }
}
