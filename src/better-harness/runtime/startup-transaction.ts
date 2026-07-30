/**
 * Better Harness startup transaction with unified CleanupController.
 *
 * All resource creation is wrapped in one outer transaction.  Every failure
 * path — acquisition error, cancellation, recoverActiveRuns failure — runs
 * the same cleanup controller.
 */
import { HarnessRuntime } from "../runtime/harness-runtime";
import { SseManager } from "../transport/sse";
import { HarnessHttpServer } from "../transport/http-server";
import { ProjectRegistry } from "../runtime/project-registry";
import type { RouterContext } from "../runtime/router-context";
import type { ResolvedBetterHarnessConfig } from "../../config/agent-models";
import { canonicalize, getServerKey, opaqueProjectId } from "./runtime-registry";

// ── CleanupController ──────────────────────────────────────────────────

export type CleanupReason = "failure" | "cancellation" | "dispose";

export interface CleanupAction {
  name: string;
  fn: () => Promise<void>;
}

export interface CleanupReport {
  reason: CleanupReason;
  attempted: string[];
  completed: string[];
  errors: Array<{ resource: string; message: string }>;
}

export class CleanupController {
  private actions: CleanupAction[] = [];
  private ran = false;
  private promise: Promise<CleanupReport> | null = null;

  add(name: string, fn: () => Promise<void>): void {
    this.actions.push({ name, fn });
  }

  async run(reason: CleanupReason): Promise<CleanupReport> {
    if (this.ran && this.promise) return this.promise;
    this.ran = true;

    if (!this.promise) {
      this.promise = (async () => {
        const attempted: string[] = [];
        const completed: string[] = [];
        const errors: Array<{ resource: string; message: string }> = [];
        for (let i = this.actions.length - 1; i >= 0; i--) {
          const a = this.actions[i];
          attempted.push(a.name);
          try { await a.fn(); completed.push(a.name); }
          catch (e) { errors.push({ resource: a.name, message: (e as Error).message }); }
        }
        return { reason, attempted, completed, errors };
      })();
    }
    return this.promise!;
  }
}

// ── Resources ──────────────────────────────────────────────────────────

export interface BhRunningResources {
  canonicalRoot: string;
  serverKey: string;
  projectKey: string;
  runtime: HarnessRuntime;
  coordinator: ReturnType<HarnessRuntime["getCoordinator"]>;
  sseManager: SseManager;
  httpServer: HarnessHttpServer;
  assignedPort: number;
  startedAt: string;
  cleanup: (reason?: CleanupReason) => Promise<CleanupReport>;
}

export type CreateResource<T> = () => T | Promise<T>;
export type ReleaseResource<T> = (resource: T) => void | Promise<void>;

/**
 * Create Better Harness resources inside a CleanupController-backed transaction.
 *
 * Every acquisition registers its release in the controller.  On failure,
 * the controller runs all releases in reverse order.  On success, the same
 * controller is returned for normal disposal.
 */
export async function createBetterHarnessResources(
  rawRoot: string,
  config: ResolvedBetterHarnessConfig,
  client: unknown,
  isCancellationRequested: () => boolean,
  log: (msg: string) => void,
): Promise<BhRunningResources> {
  const cleanup = new CleanupController();

  // Helper: acquire a resource and register reverse cleanup
  async function acquire<T>(
    name: string,
    create: CreateResource<T>,
    release: ReleaseResource<T>,
  ): Promise<T> {
    const resource = await create();
    cleanup.add(name, async () => { await release(resource); });
    return resource;
  }

  try {
    // 1. Canonicalize
    const canonicalRoot = canonicalize(rawRoot);
    if (isCancellationRequested()) throw new Error("Cancelled before registration");

    // 2. Identities
    const serverKey = getServerKey();
    const projectKey = opaqueProjectId(canonicalRoot);

    // 3. Project registry + register
    const projectRegistry = await acquire(
      "project-registry",
      () => {
        const pr = new ProjectRegistry();
        pr.register({ serverKey, projectKey, canonicalProjectRoot: canonicalRoot });
        return pr;
      },
      pr => pr.unregister(projectKey),
    );

    // 4. Runtime
    const runtime = await acquire(
      "runtime",
      () => new HarnessRuntime({ projectRoot: canonicalRoot, timeoutMs: 120_000 }),
      () => {},
    );

    // 5. Coordinator + event bus
    const coordinator = runtime.getCoordinator();
    const eventBus = coordinator.getEventBus();

    // 6. SSE manager
    const sseManager = await acquire(
      "sse-manager",
      () => new SseManager(eventBus, config.eventLogDir),
      sse => { sse.dispose(); },
    );

    // 7. Router context + HTTP server
    const routerContext: RouterContext = {
      runtime, coordinator,
      resolveProjectPath: (sk: string, pk: string) => projectRegistry.resolve(sk, pk),
      sseManager, authToken: config.authToken, authEnabled: config.authEnabled,
      bindHost: config.bindHost, opencodeClient: client,
    };

    const httpServer = await acquire(
      "http-server",
      () => {
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
      srv => { srv.stop(); },
    );

    // 8. Start HTTP listener (register stop only after start succeeds)
    const assignedPort = await httpServer.start();
    cleanup.add("http-stop", async () => { await httpServer.stop(); });

    if (isCancellationRequested()) {
      await cleanup.run("cancellation");
      throw new Error("Cancelled after HTTP start");
    }

    log("[better-harness] HTTP server started on port " + assignedPort);

    // 9. recoverActiveRuns
    try {
      coordinator.recoverActiveRuns();
    } catch (err) {
      await cleanup.run("failure");
      throw new Error(`recoverActiveRuns failed: ${(err as Error).message}`);
    }

    log("[better-harness] Recovery complete");

    if (isCancellationRequested()) {
      await cleanup.run("cancellation");
      throw new Error("Cancelled after recovery");
    }

    return {
      canonicalRoot, serverKey, projectKey,
      runtime, coordinator, sseManager, httpServer,
      assignedPort, startedAt: new Date().toISOString(),
      cleanup: (reason?: CleanupReason) => cleanup.run(reason ?? "dispose"),
    };
  } catch (err) {
    // Any failure (acquisition, cancellation, recovery) runs cleanup
    // Only run cleanup if it hasn't already been called (e.g. by cancellation checkpoints)
    const isCleanupAlreadyRun = (err as Error).message?.startsWith("Cancelled after") || (err as Error).message?.startsWith("recoverActiveRuns");
    if (!isCleanupAlreadyRun) {
      await cleanup.run(isCancellationRequested() ? "cancellation" : "failure");
    }
    throw err;
  }
}
