export interface CorsConfig {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
}

export const DEFAULT_CORS_CONFIG: CorsConfig = {
  allowedOrigins: ["http://localhost:3000", "http://localhost:5173"],
  allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

/**
 * Build CORS headers. For disallowed or missing origins, ACAO and permission
 * headers are omitted. Vary: Origin is always set.
 */
export function createCorsHeaders(config: CorsConfig, origin?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (origin && config.allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = config.allowedMethods.join(", ");
    headers["Access-Control-Allow-Headers"] = config.allowedHeaders.join(", ");
  }
  headers["Vary"] = "Origin";
  return headers;
}

/**
 * Validate a CORS preflight request. Returns null on success, or an error string.
 */
export function validatePreflight(
  config: CorsConfig,
  origin: string | undefined,
  method: string | undefined,
  reqHeaders: string | undefined,
): string | null {
  if (!origin) return "Missing Origin";
  if (!config.allowedOrigins.includes(origin)) return "Origin not allowed";
  if (!method) return "Missing Access-Control-Request-Method";
  if (!config.allowedMethods.includes(method)) return `Method not allowed: ${method}`;
  if (reqHeaders) {
    const requested = reqHeaders.split(",").map(h => h.trim().toLowerCase());
    const allowed = config.allowedHeaders.map(h => h.toLowerCase());
    for (const r of requested) {
      if (!allowed.includes(r)) return `Header not allowed: ${r}`;
    }
  }
  return null;
}
