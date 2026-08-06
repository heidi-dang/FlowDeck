/**
 * FlowDeck Better Harness — standalone development/QA server.
 *
 * EXPLICIT CLI entry point for the Better Harness runtime. This is the ONLY
 * supported way to run Better Harness. The production FlowDeck plugin never
 * activates the harness runtime (see src/index.ts and the fail-closed
 * `betterHarness.enabled=true` config validation).
 *
 * The standalone server:
 *   - writes ALL state to an explicit per-instance state directory
 *     (--state-dir, or a temp dir created at startup) and never touches
 *     canonical ~/.flowdeck/state data or canonical SQLite tables
 *     (task_runs, assignments, completion_decisions, events, event_outbox)
 *   - serves the harness HTTP API + SSE on an explicit bind host/port
 *   - shuts down gracefully on SIGINT/SIGTERM
 *
 * Usage:
 *   bun run src/better-harness/standalone.ts --project <path> [--state-dir <dir>] [--port <port>]
 *   npx @heidi-dang/flowdeck flowdeck-better-harness --project <path> [--state-dir <dir>] [--port <port>]
 *
 * Flags:
 *   --project <path>   Project directory to analyze (required)
 *   --state-dir <dir>  State directory for harness JSON persistence (optional; default: temp dir)
 *   --port <port>      HTTP port (optional; default: 0 = ephemeral OS-assigned)
 *   --host <host>      Bind host (optional; default: 127.0.0.1)
 *   --help             Show this help
 */

import { mkdtempSync, existsSync, mkdirSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { HarnessRuntime } from "./runtime/harness-runtime";
import { ProjectRegistry } from "./runtime/project-registry";
import { SseManager } from "./transport/sse";
import { RouterContext } from "./runtime/router-context";
import { HarnessHttpServer } from "./transport/http-server";

export interface StandaloneOptions {
  project: string;
  stateDir?: string;
  port?: number;
  host?: string;
}

export interface StandaloneServerHandle {
  baseUrl: string;
  port: number;
  projectDir: string;
  stateDir: string;
  eventLogDir: string;
  runtime: HarnessRuntime;
  shutdown: () => Promise<void>;
}

export function parseArgs(argv: string[]): StandaloneOptions {
  const opts: StandaloneOptions = { project: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--project":
      case "-p":
        opts.project = argv[++i] ?? "";
        break;
      case "--state-dir":
        opts.stateDir = argv[++i];
        break;
      case "--port":
        opts.port = Number(argv[++i]);
        break;
      case "--host":
        opts.host = argv[++i];
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          // eslint-disable-next-line no-console
          console.error(`[flowdeck-better-harness] Unknown flag: ${arg}`);
          printHelp();
          process.exit(2);
        }
        // Positional fallback: treat as project path
        if (!opts.project) opts.project = arg;
        break;
    }
  }
  return opts;
}

export function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`FlowDeck Better Harness — standalone development/QA server

Usage:
  flowdeck-better-harness --project <path> [--state-dir <dir>] [--port <port>] [--host <host>]

Flags:
  --project <path>   Project directory to analyze (required)
  --state-dir <dir>  State directory for harness JSON persistence (default: temp dir)
  --port <port>      HTTP port (default: 0 = ephemeral OS-assigned)
  --host <host>      Bind host (default: 127.0.0.1)
  --help             Show this help

The Better Harness runtime is a standalone development/QA facility. It is
never activated by the production FlowDeck plugin, and it never reads or
writes canonical orchestration state.
`);
}

/**
 * Start a standalone Better Harness server with explicit, instance-scoped
 * state. The state directory is passed through the runtime/coordinator so
 * ALL persistence is confined to it — the global state override is never
 * used. The server stops and cleans up on shutdown.
 */
export async function startStandaloneServer(opts: StandaloneOptions): Promise<StandaloneServerHandle> {
  if (!opts.project) {
    throw new Error("[flowdeck-better-harness] --project <path> is required");
  }
  if (!existsSync(opts.project)) {
    throw new Error(`[flowdeck-better-harness] Project directory does not exist: ${opts.project}`);
  }

  const projectDir = realpathSync(opts.project);
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "flowdeck-bh-state-"));
  if (opts.stateDir) {
    mkdirSync(stateDir, { recursive: true });
  }
  const eventLogDir = opts.stateDir
    ? join(stateDir, "events")
    : mkdtempSync(join(tmpdir(), "flowdeck-bh-events-"));
  mkdirSync(eventLogDir, { recursive: true });

  const projectKey = projectDir.split("/").filter(Boolean).pop() ?? "project";
  const serverKey = "standalone";

  // Compose the harness components with the instance-scoped stateDir.
  const runtime = new HarnessRuntime({ projectRoot: projectDir, timeoutMs: 120_000, stateDir });
  const coordinator = runtime.getCoordinator();
  const eventBus = runtime.getEventBus();

  const registry = new ProjectRegistry();
  registry.register({
    serverKey,
    projectKey,
    canonicalProjectRoot: projectDir,
  });

  const sseManager = new SseManager(eventBus, eventLogDir);

  const routerContext: RouterContext = {
    runtime,
    coordinator,
    resolveProjectPath: (sk: string, pk: string) => {
      const resolved = registry.resolve(sk, pk);
      if (resolved === null) return null;
      return projectKey;
    },
    sseManager,
    bindHost: opts.host ?? "127.0.0.1",
    stateDir,
  };

  const server = new HarnessHttpServer({
    enabled: true,
    port: opts.port ?? 0,
    bindHost: opts.host ?? "127.0.0.1",
  });
  server.setSseManager(sseManager);
  server.setRouterContext(routerContext);

  const port = await server.start();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    projectDir,
    stateDir,
    eventLogDir,
    runtime,
    shutdown: async () => {
      await Promise.race([
        server.stop(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Server stop timeout")), 5000)),
      ]).catch(() => { /* best-effort stop */ });
    },
  };
}

// ─── Direct execution (bun run src/better-harness/standalone.ts ...) ─────
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("standalone.ts")) {
  const opts = parseArgs(process.argv.slice(2));
  startStandaloneServer(opts)
    .then((handle) => {
      // eslint-disable-next-line no-console
      console.log(`[flowdeck-better-harness] Running standalone (project=${handle.projectDir})`);
      // eslint-disable-next-line no-console
      console.log(`[flowdeck-better-harness] State dir: ${handle.stateDir}`);
      // eslint-disable-next-line no-console
      console.log(`[flowdeck-better-harness] HTTP base URL: ${handle.baseUrl}`);
      // eslint-disable-next-line no-console
      console.log(`[flowdeck-better-harness] Press Ctrl+C to stop.`);

      let shuttingDown = false;
      const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        // eslint-disable-next-line no-console
        console.log(`\n[flowdeck-better-harness] Shutting down...`);
        handle.shutdown().then(() => {
          // eslint-disable-next-line no-console
          console.log(`[flowdeck-better-harness] Stopped.`);
          process.exit(0);
        }).catch((err: Error) => {
          // eslint-disable-next-line no-console
          console.error(`[flowdeck-better-harness] Shutdown error: ${err.message}`);
          process.exit(1);
        });
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error(`[flowdeck-better-harness] Failed to start: ${err.message}`);
      process.exit(1);
    });
}
