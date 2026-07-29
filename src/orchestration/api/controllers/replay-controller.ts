import type { IncomingMessage, ServerResponse } from "http";
import type { ReplayService } from "../../services/replay-service";
import { CreateReplayInputSchema } from "../../types";
import { PaginationRequestSchema } from "../../types/pagination";
import { errorHandler } from "../middleware/error-handler";
import type { RequestContext } from "../middleware/request-context";

export function createReplayController(replayService: ReplayService) {
  async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  }

  return {
    async create(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const body = await parseBody(req);
        const input = CreateReplayInputSchema.parse(body);
        const replay = await replayService.createReplay(input);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: replay }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async list(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const pagination = PaginationRequestSchema.parse(Object.fromEntries(url.searchParams));
        const result = await replayService.listReplays(pagination);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: result.items, pagination }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async get(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, replayId: string): Promise<void> {
      try {
        const replay = await replayService.getReplay(replayId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: replay }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },
  };
}
