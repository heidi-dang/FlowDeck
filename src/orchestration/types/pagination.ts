import { z } from "zod/v4";

/** Cursor-based pagination request — used for all list endpoints in the public API. */
export interface CursorPaginationRequest {
  /** Opaque cursor — pass the `nextCursor` from the previous response to fetch the next page. */
  cursor?: string;
  /** Maximum items per page (default 20, max 100). */
  limit: number;
}

/** Cursor-based pagination response — every paginated endpoint returns this shape. */
export interface CursorPaginationResponse<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Legacy page-based pagination — used internally for offset-based queries. */
export interface PagePaginationRequest {
  page: number;
  limit: number;
  sort?: string;
  order?: "asc" | "desc";
}

/** Legacy page-based pagination response. */
export interface PagePaginationResponse {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Public API pagination schema — cursor-based. */
export const CursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Internal pagination schema — page-based for database queries. */
export const PagePaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
});
