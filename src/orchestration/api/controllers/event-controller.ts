import type { IncomingMessage, ServerResponse } from "http";
import type { EventService } from "../../services/event-service";
import { EventFilterSchema } from "../../types";
import { PaginationRequestSchema } from "../../types/pagination";
import { errorHandler } from "../middleware/error-handler";
import type { RequestContext } from "../middleware/request-context";

export function createEventController(eventService: EventService) {
  return {
    async list(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const filter = EventFilterSchema.parse(Object.fromEntries(url.searchParams));
        const pagination = PaginationRequestSchema.parse(Object.fromEntries(url.searchParams));
        const result = await eventService.listEvents(filter, pagination);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: result.items, pagination }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async get(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, eventId: string): Promise<void> {
      try {
        const ev = await eventService.getEvent(eventId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: ev }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },
  };
}
