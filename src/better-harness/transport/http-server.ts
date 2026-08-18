import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { routeRequestContext } from "./router";
import { createCorsHeaders, DEFAULT_CORS_CONFIG, type CorsConfig } from "./cors";
import { createAuthCheck, type AuthConfig } from "./authentication";
import type { SseManager } from "./sse";
import type { RouterContext } from "../runtime/router-context";

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
  maxBodySize: 1024 * 1024,
  timeoutMs: 30_000,
};

export class HarnessHttpServer {
  private server: Server | null = null;
  private config: HttpServerConfig;
  private sseManager: SseManager | null = null;
  private routerContext: RouterContext | null = null;
  private hasResponded = false;

  constructor(config: Partial<HttpServerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setSseManager(manager: SseManager): void {
    this.sseManager = manager;
  }

  setRouterContext(ctx: RouterContext): void {
    this.routerContext = ctx;
  }

  start(): Promise<number> {
    if (!this.config.enabled) {
      return Promise.resolve(0);
    }

    // Fast rejection for invalid IPv4 octets to avoid DNS resolver timeout
    if (/^\d+\.\d+\.\d+\.\d+$/.test(this.config.bindHost)) {
      const octets = this.config.bindHost.split(".").map(Number);
      if (octets.some((o) => o < 0 || o > 255 || Number.isNaN(o))) {
        return Promise.reject(new Error("Invalid IPv4 address: " + this.config.bindHost));
      }
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
        this.hasResponded = false;

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

        // Fail-closed auth: non-loopback MUST have token
        const isLoopback = this.config.bindHost === "127.0.0.1" || this.config.bindHost === "localhost" || this.config.bindHost === "::1";
        if (!isLoopback) {
          const authToken = req.headers.authorization?.replace("Bearer ", "");
          if (!authCheck(authToken)) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
          }
        }

        const urlPath = req.url ?? "/";
        const method = req.method ?? "GET";

        // Detect SSE route and handle specially
        const sseRouteMatch = urlPath.match(/\/api\/v1\/servers\/([^/]+)\/projects\/([^/]+)\/better-harness\/runs\/([^/]+)\/events$/);
        if (method === "GET" && sseRouteMatch && this.sseManager) {
          const [, serverKey, projectKey, runId] = sseRouteMatch;

          // Auth check for SSE too
          if (!isLoopback) {
            const authToken = req.headers.authorization?.replace("Bearer ", "");
            if (!authCheck(authToken)) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Unauthorized" }));
              return;
            }
          }

          this.sseManager.handleSseRequest(req, res, serverKey, projectKey, runId);
          return;
        }

        // Fallback SSE detection (without route params)
        const isSseRoute = method === "GET" && urlPath.includes("/events");
        if (isSseRoute && this.sseManager) {
          if (!isLoopback) {
            const authToken = req.headers.authorization?.replace("Bearer ", "");
            if (!authCheck(authToken)) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Unauthorized" }));
              return;
            }
          }
          this.sseManager.handleSseRequest(req, res);
          return;
        }

        // Read body (for non-GET requests)
        let body = "";
        let bodySize = 0;
        const maxSize = this.config.maxBodySize ?? 1024 * 1024;
        let bodyReadError = false;

        req.on("data", (chunk: string) => {
          bodySize += chunk.length;
          if (bodySize > maxSize) {
            if (!this.hasResponded) {
              this.hasResponded = true;
              res.writeHead(413, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Request body too large" }));
            }
            req.destroy();
            bodyReadError = true;
            return;
          }
          body += chunk;
        });

        req.on("end", async () => {
          if (bodyReadError) return;

          const parsedBody = body ? parseJsonBody(body) : undefined;
          const result = await routeRequestContext(
            this.routerContext!,
            method,
            urlPath,
            parsedBody,
          );
          if (!this.hasResponded) {
            this.hasResponded = true;
            res.writeHead(result.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result.body));
          }
        });
      });

      const timeoutMs = this.config.timeoutMs ?? 30_000;
      this.server.timeout = timeoutMs;

      this.server.on("error", (err) => {
        try {
          this.server?.close();
        } catch {}
        reject(err);
      });

      try {
        this.server.listen({ port: this.config.port, host: this.config.bindHost }, () => {
          const addr = this.server?.address();
          if (addr && typeof addr === "object") {
            resolve(addr.port);
          } else {
            resolve(this.config.port);
          }
        });
      } catch (err) {
        reject(err);
      }
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

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Malformed JSON -> 400, return sentinel
    return undefined;
  }
}
