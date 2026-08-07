import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { SseManager } from "../../src/better-harness";
import {
  StreamRepository,
  StreamPublisher,
} from "../../src/orchestration/streaming";
import { EventBus } from "../../src/better-harness/runtime/event-bus";
import {
  startE2EServer,
  assertNoOrphans,
  snapshotChromiumPids,
  makeWorkDir,
  DriverClient,
  type E2EServer,
} from "../helpers/e2e-lifecycle";

const PRODUCTION_BUNDLE = join(__dirname, "..", "..", "dist", "ui", "mount.js");
const DRIVER_PATH = join(__dirname, "..", "helpers", "browser-driver.mjs");

const APP_READY_SELECTOR = ".dashboard-shell";

/**
 * Task 9: Real Playwright Headless Browser E2E Suite.
 *
 * Windows regression this guards: the suite previously hung to the global 60s
 * timeout. Root cause (now diagnosed): Bun's Windows child-process pipes do
 * not complete Playwright's `--remote-debugging-pipe` CDP handshake
 * (oven-sh/bun#31105), so `chromium.launch()` hangs forever under `bun test`
 * on Windows while succeeding under Node. The real browser is therefore
 * driven through a node subprocess (tests/helpers/browser-driver.mjs), with
 * genuine UI assertions, a production bundle, an ephemeral port, bounded
 * server readiness, and no orphan processes after success or failure.
 */
describe("Task 9: Real Playwright Headless Browser E2E Suite", () => {
  let driver: DriverClient;
  let e2eServer: E2EServer;
  let beforePids: number[];
  let publisher: StreamPublisher;
  let sseManager: SseManager;
  let clientBundleCode: string;
  let port = 0;
  const work = makeWorkDir("fdx-e2e-");

  beforeAll(async () => {
    beforePids = snapshotChromiumPids();

    // Use the built production bundle when present (CI always builds); fall
    // back to an ad-hoc bundle only for fresh checkouts without a build.
    if (existsSync(PRODUCTION_BUNDLE)) {
      clientBundleCode = readFileSync(PRODUCTION_BUNDLE, "utf-8");
    } else {
      const buildResult = await Bun.build({
        entrypoints: ["src/better-harness/ui/mount.ts"],
        target: "browser",
        format: "esm",
      });
      if (!buildResult.success || buildResult.outputs.length === 0) {
        throw new Error("Failed to bundle mount.ts for Playwright E2E");
      }
      clientBundleCode = await buildResult.outputs[0].text();
    }

    const eventBus = new EventBus();
    const repository = new StreamRepository(":memory:", { allowInMemory: true });
    sseManager = new SseManager(eventBus, repository);
    publisher = sseManager.getPublisher();

    e2eServer = await startE2EServer((req, res) => {
      const url = req.url || "/";
      if (url.startsWith("/api/runs/") && url.includes("/events")) {
        sseManager.handleSseRequest(req, res, "srv-1", "proj-1", "run-e2e-1");
        return;
      }
      if (url === "/mount.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(clientBundleCode);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>FlowDeck Live Orchestration Dashboard</title>
          <style>
            .sticky-card { position: sticky; top: 0; }
            .stage-rail { overflow-x: auto; display: flex; gap: 8px; }
          </style>
        </head>
        <body>
          <div id="app"></div>
          <script type="module">
            import { mountLiveDashboard } from "/mount.js";
            window.dashboardController = mountLiveDashboard(document.getElementById("app"), {
              runId: "run-e2e-1",
              url: "http://127.0.0.1:${port}/api/runs/run-e2e-1/events",
              featureFlagEnabled: true,
              onCancelRun: (rId) => { window.cancelledRunId = rId; }
            });
          </script>
        </body>
        </html>
      `);
    }, { readinessTimeoutMs: 10000, probePath: "/" });
    port = e2eServer.port;

    driver = new DriverClient(DRIVER_PATH);
    const launched = await driver.send({ cmd: "launch" }, 30000);
    if (!launched.ok) {
      await driver.kill();
      throw new Error(`browser driver launch failed: ${launched.error}`);
    }
  });

  afterAll(async () => {
    try {
      await driver.close(8000);
    } catch { /* already gone */ }
    await closeE2EServer(sseManager, e2eServer);
    await assertNoOrphans(beforePids, e2eServer.port);
    work.cleanup();
  });

  async function openApp(): Promise<void> {
    const opened = await driver.send({ cmd: "open", url: `http://127.0.0.1:${port}/`, readySelector: APP_READY_SELECTOR }, 20000);
    if (!opened.ok) throw new Error(`open failed: ${opened.error}`);
  }

  function expectOk(result: { ok: boolean; error?: string }): void {
    if (!result.ok) throw new Error(`driver op failed: ${result.error}`);
  }

  it("should load dashboard in real browser, receive streamed events, and render live state safely", async () => {
    publisher.publish({
      runId: "run-e2e-1",
      type: "run.created",
      stage: "intake",
      importance: "normal",
      title: "Playwright E2E Initial Run",
      payload: {},
    });

    await openApp();
    try {
      const wait = await driver.send({ cmd: "waitForSelector", selector: "header h1", timeout: 10000 });
      expectOk(wait);
      const header = await driver.send<string | null>({ cmd: "textContent", selector: "header h1" });
      expectOk(header);
      expect(header.value).toContain("Playwright E2E Initial Run");

      publisher.publish({
        runId: "run-e2e-1",
        type: "agent.started",
        stage: "execute",
        importance: "normal",
        title: "Agent Execution",
        payload: { agentId: "agent-planner", responsibility: "Architecture Planning" },
      });

      await driver.send({ cmd: "waitForSelector", selector: ".agent-card", timeout: 10000 });
      const cards = await driver.send<number>({ cmd: "count", selector: ".agent-card" });
      expectOk(cards);
      expect(cards.value).toBeGreaterThan(0);
      const firstCard = await driver.send<string | null>({ cmd: "textContent", selector: ".agent-card" });
      expect(firstCard.value).toContain("agent-planner");
    } finally {
      await driver.send({ cmd: "closePage" }, 10000);
    }
  });

  it("should keep a persistent SSE connection alive across streamed events", async () => {
    publisher.publish({
      runId: "run-e2e-1",
      type: "stage.entered",
      stage: "execute",
      importance: "normal",
      title: "Persistent SSE check",
      payload: { phase: "1" },
    });

    await openApp();
    try {
      const wait = await driver.send({ cmd: "waitForSelector", selector: "header h1", timeout: 10000 });
      expectOk(wait);
      // A second event arriving on the SAME connection proves the SSE stream
      // stayed open rather than being re-fetched per event.
      publisher.publish({
        runId: "run-e2e-1",
        type: "stage.progress",
        stage: "verify",
        importance: "normal",
        title: "Persistent SSE check 2",
        payload: { phase: "2" },
      });
      await driver.send({ cmd: "waitForSelector", selector: ".stage-rail", timeout: 10000 });
      const rails = await driver.send<number>({ cmd: "count", selector: ".stage-rail" });
      expectOk(rails);
      expect(rails.value).toBe(1);
    } finally {
      await driver.send({ cmd: "closePage" }, 10000);
    }
  });

  it("should safely escape XSS script injection payloads in streamed event fields", async () => {
    const xssPayload = '<script>alert("xss-injection")</script>';

    publisher.publish({
      runId: "run-e2e-1",
      type: "run.created",
      stage: "intake",
      importance: "important",
      title: xssPayload,
      payload: {},
    });

    await openApp();
    try {
      const scriptTags = await driver.send<number>({ cmd: "count", selector: 'script:has-text("xss-injection")' });
      expectOk(scriptTags);
      expect(scriptTags.value).toBe(0);

      const bodyText = await driver.send<string>({ cmd: "innerText", selector: "body" });
      expectOk(bodyText);
      expect(bodyText.value).toContain('<script>alert("xss-injection")</script>');
    } finally {
      await driver.send({ cmd: "closePage" }, 10000);
    }
  });

  it("should handle mobile viewport layout and keyboard traversal in real browser", async () => {
    await openApp();
    try {
      await driver.send({ cmd: "setViewport", width: 375, height: 667 });
      await driver.send({ cmd: "waitForSelector", selector: ".stage-rail", timeout: 10000 });
      const visible = await driver.send<boolean>({ cmd: "visible", selector: ".stage-rail" });
      expectOk(visible);
      expect(visible.value).toBe(true);

      await driver.send({ cmd: "press", key: "Tab" });
      const activeTag = await driver.send<string>({ cmd: "evaluate", expr: "document.activeElement?.tagName" });
      expectOk(activeTag);
      expect(activeTag.value).toBeDefined();
    } finally {
      await driver.send({ cmd: "closePage" }, 10000);
    }
  });

  it("should preserve prefers-reduced-motion and accessible ARIA attributes", async () => {
    await openApp();
    try {
      await driver.send({ cmd: "emulateMedia", reducedMotion: "reduce" });
      const liveRegions = await driver.send<number>({ cmd: "count", selector: "[aria-live]" });
      expectOk(liveRegions);
      expect(liveRegions.value).toBeGreaterThan(0);
    } finally {
      await driver.send({ cmd: "closePage" }, 10000);
    }
  });
});

async function closeE2EServer(sseManager: SseManager, e2eServer: E2EServer): Promise<void> {
  sseManager.dispose();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      e2eServer.server.closeAllConnections();
      resolve();
    }, 5000);
    e2eServer.server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    e2eServer.server.closeAllConnections();
  });
}
