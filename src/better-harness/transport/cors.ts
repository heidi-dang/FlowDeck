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

export function createCorsHeaders(config: CorsConfig, origin?: string): Record<string, string> {
  const headers: Record<string, string> = {};

  if (origin && config.allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  } else {
    headers["Access-Control-Allow-Origin"] = "http://localhost:3000";
  }

  headers["Access-Control-Allow-Methods"] = config.allowedMethods.join(", ");
  headers["Access-Control-Allow-Headers"] = config.allowedHeaders.join(", ");
  return headers;
}
