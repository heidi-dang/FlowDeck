import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { routeRequest } from "./router";
import { createCorsHeaders, DEFAULT_CORS_CONFIG, type CorsConfig } from "./cors";
import { createAuthCheck, type AuthConfig } from "./authentication";
import type { SseManager } from "./sse";

export interface HttpServerConfig {
  enabled: boolean;
  bindHost: string;
  port: number;
  cors?: Partial<CorsConfig>;
  auth?: Partial<AuthConfig>;
  maxBodySize?: number;
  timeoutMs?: number;
}

const DEFAULT_CONFIG: HttpServerConfig = {
  enabled: false,
  bindHost: "127.0.0.1",
  port: 0,
  maxBodySize: 1024 * 1024, // 1MB
  timeoutMs: 30_000,
};

export class HarnessHttpServer {
  private server: Server | null = null;
  private config: HttpServerConfig;
  private sseManager: SseManager | null = null;

  constructor(config: Partial<HttpServerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setSseManager(manager: SseManager): void {
    this.sseManager = manager;
  }

  start(): Promise<number> {
    if (!this.config.enabled) {
      return Promise.resolve(0);
    }

    const corsConfig: CorsConfig = {
      ...DEFAULT_CORS_CONFIG,
      ...this.config.cors,
    };

    const authCheck = createAuthCheck({
      token: this.config.auth?.token ?? null,
      enabled: this.config.auth?.enabled ?? false,
    });

    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // CORS headers
        const corsHeaders = createCorsHeaders(corsConfig, req.headers.origin);
        for (const [key, val] of Object.entries(corsHeaders)) {
          res.setHeader(key, val);
        }

        // Handle preflight
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // Auth check for non-loopback
        if (this.config.bindHost !== "127.0.0.1" && this.config.bindHost !== "localhost") {
          const authToken = req.headers.authorization?.replace("Bearer ", "");
          if (!authCheck(authToken)) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
          }
        }

        const urlPath = req.url ?? "/";
        const method = req.method ?? "GET";

        // Detect SSE route early
        const isSseRoute = method === "GET" && urlPath.includes("/events");
        if (isSseRoute && this.sseManager) {
          this.sseManager.handleSseRequest(req, res);
          return;
        }

        // Read body (for non-GET requests)
        let body = "";
        let bodySize = 0;
        const maxSize = this.config.maxBodySize ?? 1024 * 1024;

        req.on("data", (chunk: string) => {
          bodySize += chunk.length;
          if (bodySize > maxSize) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Request body too large" }));
            req.destroy();
            return;
          }
          body += chunk;
        });

        req.on("end", async () => {
          const parsedBody = body ? tryParseJson(body) : undefined;
          // Pass sseManager and resolveProjectPath (null for now, wired externally)
          const result = await routeRequest(method, urlPath, parsedBody, undefined, this.sseManager ?? undefined);
          res.writeHead(result.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result.body));
        });
      });

      const timeoutMs = this.config.timeoutMs ?? 30_000;
      this.server.timeout = timeoutMs;

      this.server.listen(this.config.port, this.config.bindHost, () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          resolve(this.config.port);
        }
      });

      this.server.on("error", reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
