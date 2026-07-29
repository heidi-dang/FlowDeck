import type { IncomingMessage, ServerResponse } from "http";
import type { RunService } from "../../services/run-service";
import { CreateRunInputSchema, UpdateRunInputSchema, RunFilterSchema } from "../../types";
import { PaginationRequestSchema } from "../../types/pagination";
import { errorHandler } from "../middleware/error-handler";
import type { RequestContext } from "../middleware/request-context";

export function createRunController(runService: RunService) {
  return {
    async create(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const body = await parseBody(req);
        const input = CreateRunInputSchema.parse(body);
        const run = await runService.createRun(input, ctx.correlationId);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: run }));
      } catch (err) {
        errorHandler(err, req, res, ctx);
      }
    },

    async list(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const filter = RunFilterSchema.parse(Object.fromEntries(url.searchParams));
        const pagination = PaginationRequestSchema.parse(Object.fromEntries(url.searchParams));
        const result = await runService.listRuns(filter, pagination);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: result.items, pagination: { page: pagination.page, limit: pagination.limit, total: result.total } }));
      } catch (err) {
        errorHandler(err, req, res, ctx);
      }
    },

    async get(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, runId: string): Promise<void> {
      try {
        const run = await runService.getRun(runId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: run }));
      } catch (err) {
        errorHandler(err, req, res, ctx);
      }
    },

    async update(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, runId: string): Promise<void> {
      try {
        const body = await parseBody(req);
        const input = UpdateRunInputSchema.parse(body);
        const run = await runService.updateRun(runId, input);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: run }));
      } catch (err) {
        errorHandler(err, req, res, ctx);
      }
    },

    async cancel(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, runId: string): Promise<void> {
      try {
        const body = await parseBody(req);
        const run = await runService.cancelRun(runId, body.reason as string | undefined);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: run }));
      } catch (err) {
        errorHandler(err, req, res, ctx);
      }
    },

    async pause(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, runId: string): Promise<void> {
      try {
        const run = await runService.pauseRun(runId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: run }));
      } catch (err) {
        errorHandler(err, req, res, ctx);
      }
    },
  };
}

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString() || "{}";
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
