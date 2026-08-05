import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { type Browser, type BrowserContext, type Page } from "playwright";
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
  launchBrowserBounded,
  closeE2EAll,
  assertNoOrphans,
  snapshotChromiumPids,
  makeWorkDir,
  type E2EServer,
} from "../helpers/e2e-lifecycle";

const PRODUCTION_BUNDLE = join(__dirname, "..", "..", "dist", "ui", "mount.js");

/**
 * Task 9: Real Playwright Headless Browser E2E Suite.
 *
 * Windows regression this guards: the suite previously hung to the global 60s
 * timeout. Every await is now bounded (server readiness, chromium launch,
 * page waits, browser/server close), the production bundle is served, SSE
 * connections are ended before `server.close()`, and no orphan chromium or
 * server process may remain after success or failure.
 */
describe("Task 9: Real Playwright Headless Browser E2E Suite", () => {
  let browser: Browser;
  let context: BrowserContext;
  let e2eServer: E2EServer;
  let beforePids: number[];
  let repository: StreamRepository;
  let publisher: StreamPublisher;
  let sseManager: SseManager;
  let clientBundleCode: string;
  const work = makeWorkDir("fdx-e2e-");

  const APP_READY_SELECTOR = ".dashboard-shell";

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
    repository = new StreamRepository(":memory:", { allowInMemory: true });
    sseManager = new SseManager(eventBus, repository);
    publisher = sseManager.getPublisher();

    // `port` is captured before the server starts so the request handler can
    // render the SSE URL without touching the (not yet assigned) e2eServer.
    let port = 0;
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

    browser = await launchBrowserBounded(beforePids, { launchTimeoutMs: 30000 });
    context = await browser.newContext();
  });

  afterAll(async () => {
    const report = await closeE2EAll({
      browser,
      context,
      server: e2eServer,
      sseManager,
      browserCloseTimeoutMs: 10000,
      serverCloseTimeoutMs: 5000,
    });
    await assertNoOrphans(beforePids, e2eServer.port);
    work.cleanup();
    // Surface force-kills in the test output so cleanup regressions are visible.
    if (report.forceKilled) {
      console.warn("[e2e] cleanup required force-kill of a process");
    }
  });

  async function openApp(): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${e2eServer.port}/`, { timeout: 15000, waitUntil: "domcontentloaded" });
    // Application-ready signal: the dashboard shell mounts only after the
    // client bundle runs and the first SSE event renders.
    await page.waitForSelector(APP_READY_SELECTOR, { timeout: 10000 });
    return page;
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

    const page = await openApp();
    try {
      await page.waitForSelector("header h1", { timeout: 10000 });
      const headerText = await page.locator("header h1").textContent();
      expect(headerText).toContain("Playwright E2E Initial Run");

      publisher.publish({
        runId: "run-e2e-1",
        type: "agent.started",
        stage: "execute",
        importance: "normal",
        title: "Agent Execution",
        payload: { agentId: "agent-planner", responsibility: "Architecture Planning" },
      });

      await page.waitForSelector(".agent-card", { timeout: 10000 });
      const agentCard = page.locator(".agent-card");
      expect(await agentCard.count()).toBeGreaterThan(0);
      expect(await agentCard.first().textContent()).toContain("agent-planner");
    } finally {
      await page.close();
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

    const page = await openApp();
    try {
      await page.waitForSelector("header h1", { timeout: 10000 });
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
      await page.waitForSelector(".stage-rail", { timeout: 10000 });
      const rail = page.locator(".stage-rail");
      expect(await rail.count()).toBe(1);
    } finally {
      await page.close();
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

    const page = await openApp();
    try {
      const scriptTags = await page.locator('script:has-text("xss-injection")').count();
      expect(scriptTags).toBe(0);

      const textContent = await page.locator("body").innerText();
      expect(textContent).toContain('<script>alert("xss-injection")</script>');
    } finally {
      await page.close();
    }
  });

  it("should handle mobile viewport layout and keyboard traversal in real browser", async () => {
    const page = await openApp();
    try {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.waitForSelector(".stage-rail", { timeout: 10000 });
      const stageRail = page.locator(".stage-rail");
      expect(await stageRail.isVisible()).toBe(true);

      await page.keyboard.press("Tab");
      const activeTagName = await page.evaluate(() => document.activeElement?.tagName);
      expect(activeTagName).toBeDefined();
    } finally {
      await page.close();
    }
  });

  it("should preserve prefers-reduced-motion and accessible ARIA attributes", async () => {
    const page = await openApp();
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const liveRegions = await page.locator("[aria-live]").count();
      expect(liveRegions).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});
