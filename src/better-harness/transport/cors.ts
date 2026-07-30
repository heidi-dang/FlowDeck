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
 * Build CORS headers for an HTTP response.
 *
 * Rules:
 *   - When the request origin is in the configured allowed list, echo
 *     that origin in Access-Control-Allow-Origin.
 *   - When the origin is missing or disallowed, OMIT the
 *     Access-Control-Allow-Origin header (do not fall back to a fixed
 *     localhost origin).
 *   - Always set Vary: Origin so caches key on the Origin header.
 *   - When responding to a specific origin, do NOT use a wildcard.
 */
/**
 * Build CORS headers for an HTTP response.
 *
 * For disallowed or missing origins, Access-Control-Allow-Origin is omitted
 * and permission headers (Allow-Methods, Allow-Headers) are not emitted.
 */
export function createCorsHeaders(config: CorsConfig, origin?: string): Record<string, string> {
  const headers: Record<string, string> = {};

  // Allowed origin: echo back the exact origin; set permission headers
  if (origin && config.allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = config.allowedMethods.join(", ");
    headers["Access-Control-Allow-Headers"] = config.allowedHeaders.join(", ");
  }
  // Disallowed or missing origin: omit all CORS response headers (no implicit localhost fallback)

  headers["Vary"] = "Origin";
  return headers;
}

/**
 * Validate a preflight request. Returns an error message string when the
 * request should be rejected, or null when the preflight is valid.
 *
 * methodHeader: value of Access-Control-Request-Method
 * headersHeader: value of Access-Control-Request-Headers
 */
export function validatePreflight(
  config: CorsConfig,
  origin: string | undefined,
  methodHeader: string | undefined,
  headersHeader: string | undefined,
): string | null {
  if (!origin) return "Missing Origin";
  if (!config.allowedOrigins.includes(origin)) return "Origin not allowed";
  if (!methodHeader) return "Missing Access-Control-Request-Method";
  if (!config.allowedMethods.includes(methodHeader)) return `Method not allowed: ${methodHeader}`;
  if (headersHeader) {
    const requested = headersHeader.split(",").map(h => h.trim().toLowerCase());
    const allowed = config.allowedHeaders.map(h => h.toLowerCase());
    for (const r of requested) {
      if (!allowed.includes(r)) return `Header not allowed: ${r}`;
    }
  }
  return null;
}
