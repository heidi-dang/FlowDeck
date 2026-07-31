import type { IncomingMessage, ServerResponse } from "http";
import type { CompletionService } from "../../services/completion-service";
import { CreateCompletionInputSchema, OrchestrationError, ErrorCodes } from "../../types";
import { errorHandler } from "../middleware/error-handler";
import type { RequestContext } from "../middleware/request-context";

function parseOutcome(raw: unknown): "success" | "failure" | "partial" {
  if (raw === "success" || raw === "failure" || raw === "partial") {
    return raw;
  }
  throw OrchestrationError.fromCode(ErrorCodes.INVALID_INPUT, {
    message: `Invalid completion outcome: "${String(raw)}". Expected "success", "failure", or "partial".`,
  });
}

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
        const outcome = parseOutcome(body.outcome);
        const summary = typeof body.summary === "string" ? body.summary : "";
        const c = await completionService.completeRun(completionId, summary, outcome);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: c }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },
  };
}
