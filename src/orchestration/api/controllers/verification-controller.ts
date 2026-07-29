import type { IncomingMessage, ServerResponse } from "http";
import type { VerificationService } from "../../services/verification-service";
import { VerificationFilterSchema } from "../../types";
import { PaginationRequestSchema } from "../../types/pagination";
import { errorHandler } from "../middleware/error-handler";
import type { RequestContext } from "../middleware/request-context";

export function createVerificationController(verificationService: VerificationService) {
  return {
    async list(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const filter = VerificationFilterSchema.parse(Object.fromEntries(url.searchParams));
        const pagination = PaginationRequestSchema.parse(Object.fromEntries(url.searchParams));
        const result = await verificationService.listVerifications(filter, pagination);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: result.items, pagination }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async get(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, verificationId: string): Promise<void> {
      try {
        const v = await verificationService.getVerification(verificationId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: v }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async listEvidence(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, runId: string): Promise<void> {
      try {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },
  };
}
