import type { IncomingMessage, ServerResponse } from "http";
import type { CompletionService } from "../../services/completion-service";
import { CreateCompletionInputSchema } from "../../types";
import { errorHandler } from "../middleware/error-handler";
import type { RequestContext } from "../middleware/request-context";

export function createCompletionController(completionService: CompletionService) {
  async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  }

  return {
    async create(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const body = await parseBody(req);
        const input = CreateCompletionInputSchema.parse(body);
        const completion = await completionService.createCompletion(input);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: completion }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async get(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, completionId: string): Promise<void> {
      try {
        const c = await completionService.getCompletion(completionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: c }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async finalize(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, completionId: string): Promise<void> {
      try {
        const body = await parseBody(req);
        const c = await completionService.completeRun(completionId, body.summary as string, body.outcome as any);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: c }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },
  };
}
