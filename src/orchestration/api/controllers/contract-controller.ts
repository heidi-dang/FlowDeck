import type { IncomingMessage, ServerResponse } from "http";
import type { ContractService } from "../../services/contract-service";
import { CreateContractInputSchema, UpdateContractInputSchema, ContractFilterSchema } from "../../types";
import { PaginationRequestSchema } from "../../types/pagination";
import { errorHandler } from "../middleware/error-handler";
import type { RequestContext } from "../middleware/request-context";

export function createContractController(contractService: ContractService) {
  async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  }

  return {
    async create(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const body = await parseBody(req);
        const input = CreateContractInputSchema.parse(body);
        const contract = await contractService.createContract(input);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: contract }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async list(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const filter = ContractFilterSchema.parse(Object.fromEntries(url.searchParams));
        const pagination = PaginationRequestSchema.parse(Object.fromEntries(url.searchParams));
        const result = await contractService.listContracts(filter, pagination);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: result.items, pagination }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async get(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, contractId: string): Promise<void> {
      try {
        const contract = await contractService.getContract(contractId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: contract }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },

    async update(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, contractId: string): Promise<void> {
      try {
        const body = await parseBody(req);
        const input = UpdateContractInputSchema.parse(body);
        const contract = await contractService.updateContract(contractId, input);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: contract }));
      } catch (err) { errorHandler(err, req, res, ctx); }
    },
  };
}
