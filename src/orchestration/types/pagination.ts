import { z } from "zod/v4";

export interface PaginationRequestDTO {
  page: number;
  limit: number;
  sort?: string;
  order?: "asc" | "desc";
}

export interface PaginationResponseDTO {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export const PaginationRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
});
