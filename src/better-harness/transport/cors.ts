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
export function createCorsHeaders(config: CorsConfig, origin?: string): Record<string, string> {
  const headers: Record<string, string> = {};

  if (origin && config.allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  // Disallowed or missing origin: omit Access-Control-Allow-Origin

  headers["Vary"] = "Origin";
  headers["Access-Control-Allow-Methods"] = config.allowedMethods.join(", ");
  headers["Access-Control-Allow-Headers"] = config.allowedHeaders.join(", ");
  return headers;
}
