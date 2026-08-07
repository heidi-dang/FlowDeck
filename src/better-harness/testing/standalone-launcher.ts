/**
 * Standalone FlowDeck integration launcher.
 *
 * Composes exported components directly without requiring the full OpenCode
 * plugin entry point (src/index.ts). Uses an ephemeral port and temporary
 * project/state directories.
 *
 * Usage:
 *   const meta = await launchStandaloneServer();
 *   // meta = { baseUrl, serverKey, projectKey, projectId }
 *   // ... run lifecycle tests ...
 *   await meta.shutdown();
 */

import { randomBytes } from "crypto";
import { mkdtempSync, writeFileSync, realpathSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { HarnessRuntime } from "../runtime/harness-runtime";
import { ProjectRegistry } from "../runtime/project-registry";
import { SseManager } from "../transport/sse";
import { RouterContext } from "../runtime/router-context";
import { HarnessHttpServer } from "../transport/http-server";
import { captureWorkspaceSnapshot } from "../workspace/workspace-snapshot";
import { resetFlowDeckStateDir } from "../persistence/harness-store";

export interface StandaloneServerMeta {
  baseUrl: string;
  serverKey: string;
  projectKey: string;
  /** The project identifier used by the persistence layer. Derived from workspace snapshot. */
  projectId: string;
  port: number;
  projectDir: string;
  stateDir: string;
  eventLogDir: string;
  shutdown: () => Promise<void>;
}

/**
 * Launch a standalone FlowDeck Better Harness HTTP server for integration testing.
 * Uses an OS-assigned ephemeral port and temporary directories.
 * Cleans up all temporary files and processes on shutdown.
 * Returns connection metadata including a projectId that matches the persistence namespace.
 */
export async function launchStandaloneServer(
  serverKey?: string,
  projectKey?: string,
): Promise<StandaloneServerMeta> {
  const actualServerKey = serverKey ?? "test-server-" + randomBytes(4).toString("hex");
  const actualProjectKey = projectKey ?? "test-project-" + randomBytes(4).toString("hex");

  // Create temporary directories
  const projectDir = mkdtempSync(join(tmpdir(), "flowdeck-integration-"));
  const stateDir = mkdtempSync(join(tmpdir(), "flowdeck-state-"));
  const eventLogDir = mkdtempSync(join(tmpdir(), "flowdeck-events-"));

  // Create a minimal project file so workspace snapshot works
  const opencodeDir = join(projectDir, ".opencode");
  if (!existsSync(opencodeDir)) {
    mkdirSync(opencodeDir, { recursive: true });
  }
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "test-project" }));

  // Pre-compute the project ID that the persistence layer will use
  // This must match what RunCoordinator.enqueueRun computes via captureWorkspaceSnapshot
  const snapshot = captureWorkspaceSnapshot(projectDir);
  const projectId = snapshot.projectId;

  // Compose components — pass stateDir so all persistence goes to the temp dir
  const runtime = new HarnessRuntime({ projectRoot: projectDir, timeoutMs: 60000, stateDir });
  const coordinator = runtime.getCoordinator();
  const eventBus = runtime.getEventBus();
  const registry = new ProjectRegistry();
  registry.register({
    serverKey: actualServerKey,
    projectKey: actualProjectKey,
    canonicalProjectRoot: realpathSync(projectDir),
  });

  const sseManager = new SseManager(eventBus, eventLogDir);

  const routerContext: RouterContext = {
    runtime,
    coordinator,
    // Validate project key against the registry before returning the
    // persistence projectId. If the project is not registered, return null
    // so the router returns 404.
    resolveProjectPath: (sk: string, pk: string) => {
      const resolved = registry.resolve(sk, pk);
      if (resolved === null) return null;
      return projectId;
    },
    sseManager,
    bindHost: "127.0.0.1",
    stateDir,
  };

  const server = new HarnessHttpServer({
    enabled: true,
    port: 0, // ephemeral
    bindHost: "127.0.0.1",
  });
  server.setSseManager(sseManager);
  server.setRouterContext(routerContext);

  const port = await server.start();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    serverKey: actualServerKey,
    projectKey: actualProjectKey,
    projectId,
    port,
    projectDir,
    stateDir,
    eventLogDir,
    shutdown: async () => {
      // Reset state dir override so no lingering references remain
      resetFlowDeckStateDir();
      // Stop the server with a timeout to avoid hanging on active connections
      await Promise.race([
        server.stop(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Server stop timeout")), 5000)),
      ]).catch(() => { /* best-effort stop */ });
      // Clean up temp dirs (best effort)
      try {
        rmSync(projectDir, { recursive: true, force: true });
      } catch { /* best-effort cleanup */ }
      try {
        rmSync(stateDir, { recursive: true, force: true });
      } catch { /* best-effort cleanup */ }
      try {
        rmSync(eventLogDir, { recursive: true, force: true });
      } catch { /* best-effort cleanup */ }
    },
  };
}
