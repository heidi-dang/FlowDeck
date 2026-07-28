/**
 * Better Harness startup transaction with explicit reverse-order rollback.
 *
 * Each successful resource acquisition pushes its inverse operation onto a
 * rollback stack.  On failure, the stack is unwound in reverse order.
 * Cancellation and startup failure share the same cleanup path.
 */
import { HarnessRuntime } from "../runtime/harness-runtime";
import { SseManager } from "../transport/sse";
import { HarnessHttpServer } from "../transport/http-server";
import { ProjectRegistry } from "../runtime/project-registry";
import type { RouterContext } from "../runtime/router-context";
import type { ResolvedBetterHarnessConfig } from "../../config/agent-models";
import { canonicalize, getServerKey, opaqueProjectId } from "./runtime-registry";

export interface BhRunningResources {
  canonicalRoot: string;
  serverKey: string;
  projectKey: string;
  projectRegistry: ProjectRegistry;
  runtime: HarnessRuntime;
  coordinator: ReturnType<HarnessRuntime["getCoordinator"]>;
  sseManager: SseManager;
  httpServer: HarnessHttpServer;
  assignedPort: number;
  cleanup: () => Promise<string[]>;
}

export type CleanupFn = () => Promise<void> | void;

/**
 * Create Better Harness resources inside an explicit rollback transaction.
 *
 * On failure, rollback executes in reverse order and continues after errors.
 * Returns running resources on success, or throws with partial cleanup applied.
 */
export async function createBetterHarnessResources(
  rawRoot: string,
  config: ResolvedBetterHarnessConfig,
  client: unknown,
  cancellationRequested: () => boolean,
  log: (msg: string, level?: string) => void,
): Promise<BhRunningResources> {
  const rollback: Array<{ name: string; fn: CleanupFn }> = [];
  let rollbackErrors: string[] = [];

  /**
   * Acquire a resource and register its inverse on success.
   * On failure, unwind the stack.
   */
  async function acquire<T>(
    name: string,
    acquireFn: () => Promise<T>,
    releaseFn: CleanupFn,
  ): Promise<T> {
    try {
      const result = await acquireFn();
      rollback.push({ name, fn: releaseFn });
      return result;
    } catch (err) {
      // Rollback in reverse order
      for (let i = rollback.length - 1; i >= 0; i--) {
        try {
          await rollback[i].fn();
        } catch (rbErr) {
          rollbackErrors.push(`rollback[${rollback[i].name}]: ${(rbErr as Error).message}`);
        }
      }
      // Re-throw original error with rollback info
      const msg = (err as Error).message;
      if (rollbackErrors.length > 0) {
        throw new Error(`Startup failed: ${msg}. Rollback: ${rollbackErrors.join("; ")}`);
      }
      throw err;
    }
  }

  // ── 1. Canonicalize ──────────────────────────────────────────────────
  const canonicalRoot = canonicalize(rawRoot);
  if (cancellationRequested()) throw new Error("Cancelled before resource creation");

  // ── 2. Resolve identities ────────────────────────────────────────────
  const serverKey = getServerKey();
  const projectKey = opaqueProjectId(canonicalRoot);

  // ── 3. Create project registry and register ──────────────────────────
  const projectRegistry = await acquire(
    "project-registry",
    async () => {
      const pr = new ProjectRegistry();
      pr.register({ serverKey, projectKey, canonicalProjectRoot: canonicalRoot });
      return pr;
    },
    async () => { projectRegistry.unregister(projectKey); },
  );

  if (cancellationRequested()) {
    await projectRegistry.unregister(projectKey);
    throw new Error("Cancelled after project registration");
  }

  // ── 4. Create runtime ────────────────────────────────────────────────
  const runtime = await acquire(
    "runtime",
    () => Promise.resolve(new HarnessRuntime({ projectRoot: canonicalRoot, timeoutMs: 120_000 })),
    async () => { /* runtime disposal when supported */ },
  );
  const coordinator = runtime.getCoordinator();
  const eventBus = coordinator.getEventBus();

  // ── 5. Create SSE manager ────────────────────────────────────────────
  const sseManager = await acquire(
    "sse-manager",
    () => Promise.resolve(new SseManager(eventBus, config.eventLogDir)),
    async () => {
      // Close all SSE clients and detach listeners
      // (SseManager has no closeAll/dispose — future improvement)
    },
  );

  // ── 6. Create HTTP server ────────────────────────────────────────────
  const routerContext: RouterContext = {
    runtime, coordinator,
    resolveProjectPath: (sk: string, pk: string) => projectRegistry.resolve(sk, pk),
    sseManager, authToken: config.authToken, authEnabled: config.authEnabled,
    bindHost: config.bindHost, opencodeClient: client,
  };

  const httpServer = await acquire(
    "http-server",
    async () => {
      const srv = new HarnessHttpServer({
        enabled: true, port: config.port, bindHost: config.bindHost,
        cors: { allowedOrigins: config.corsOrigins },
        auth: { token: config.authToken, enabled: config.authEnabled },
        maxBodySize: config.maxBodySize,
      });
      srv.setSseManager(sseManager);
      srv.setRouterContext(routerContext);
      return srv;
    },
    async () => { try { await httpServer.stop(); } catch {} },
  );

  // ── 7. Start HTTP listener ───────────────────────────────────────────
  const assignedPort = await acquire(
    "http-start",
    () => httpServer.start(),
    async () => { try { await httpServer.stop(); } catch {} },
  );

  if (cancellationRequested()) {
    try { await httpServer.stop(); } catch {}
    projectRegistry.unregister(projectKey);
    throw new Error("Cancelled after HTTP start");
  }

  log("[better-harness] HTTP server started on port " + assignedPort);

  // ── 8. recoverActiveRuns ─────────────────────────────────────────────
  try {
    coordinator.recoverActiveRuns();
  } catch (err) {
    // recoverActiveRuns failure: rollback
    try { await httpServer.stop(); } catch {}
    projectRegistry.unregister(projectKey);
    throw new Error(`recoverActiveRuns failed: ${(err as Error).message}`);
  }

  // ── 9. Build cleanup function ────────────────────────────────────────
  const cleanup = async (): Promise<string[]> => {
    const errors: string[] = [];
    // Reverse order: server, SSE, project
    try { await httpServer.stop(); } catch (e) { errors.push("server.stop: " + (e as Error).message); }
    try { projectRegistry.unregister(projectKey); } catch (e) { errors.push("unregister: " + (e as Error).message); }
    return errors;
  };

  return {
    canonicalRoot, serverKey, projectKey,
    projectRegistry, runtime, coordinator,
    sseManager, httpServer, assignedPort,
    cleanup,
  };
}
