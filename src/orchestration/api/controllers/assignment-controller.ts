import type { IncomingMessage, ServerResponse } from "http";
import type { AssignmentService } from "../../services/assignment-service";
import { CreateAssignmentInputSchema, UpdateAssignmentInputSchema, AssignmentFilterSchema } from "../../types";
import { PagePaginationSchema } from "../../types/pagination";
import { errorHandler } from "../middleware/error-handler";
import type { RequestContext } from "../middleware/request-context";

export function createAssignmentController(assignmentService: AssignmentService) {
  async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  }

  return {
    async create(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const body = await parseBody(req);
        const input = CreateAssignmentInputSchema.parse(body);
        const assignment = await assignmentService.createAssignment(input);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: assignment }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async list(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const filter = AssignmentFilterSchema.parse(Object.fromEntries(url.searchParams));
        const pagination = PagePaginationSchema.parse(Object.fromEntries(url.searchParams));
        const result = await assignmentService.listAssignments(filter, pagination);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: result.items, pagination }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async get(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, assignmentId: string): Promise<void> {
      try {
        const a = await assignmentService.getAssignment(assignmentId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: a }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async update(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, assignmentId: string): Promise<void> {
      try {
        const body = await parseBody(req);
        const input = UpdateAssignmentInputSchema.parse(body);
        const a = await assignmentService.updateAssignment(assignmentId, input);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: a }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },
  };
}
