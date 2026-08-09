import type { IncomingMessage, ServerResponse } from "http"
import type { RequestContext } from "../middleware/request-context"
import { errorHandler } from "../middleware/error-handler"
import type { RuntimeSnapshotService } from "../../services/runtime-snapshot"
export function createSnapshotController(service: RuntimeSnapshotService) { return { async get(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> { try { const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: service.get(url.searchParams.get("runId") ?? undefined) })) } catch (err) { errorHandler(err, req, res, ctx) } } } }
