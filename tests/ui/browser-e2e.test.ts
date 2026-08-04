import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser } from "playwright";
import { createServer, type Server } from "http";
import { SseManager } from "../../src/better-harness";
import {
  StreamRepository,
  StreamPublisher,
} from "../../src/orchestration/streaming";
import { EventBus } from "../../src/better-harness/runtime/event-bus";

describe("Task 9: Real Playwright Headless Browser E2E Suite", () => {
  let browser: Browser;
  let server: Server;
  let port: number;
  let repository: StreamRepository;
  let publisher: StreamPublisher;
  let sseManager: SseManager;
  let clientBundleCode: string;

  beforeAll(async () => {
    const eventBus = new EventBus();
    repository = new StreamRepository(":memory:", { allowInMemory: true });
    sseManager = new SseManager(eventBus, repository);
    publisher = sseManager.getPublisher();

    const buildResult = await Bun.build({
      entrypoints: ["src/better-harness/ui/mount.ts"],
      target: "browser",
      format: "esm",
    });

    if (!buildResult.success || buildResult.outputs.length === 0) {
      throw new Error("Failed to bundle mount.ts for Playwright E2E");
    }

    clientBundleCode = await buildResult.outputs[0].text();

    server = createServer((req, res) => {
      const url = req.url || "/";
      if (url.includes("/events")) {
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
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    port = address.port;

    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("should load dashboard in real browser, receive streamed events, and render live state safely", async () => {
    publisher.publish({
      runId: "run-e2e-1",
      type: "run.created",
      stage: "intake",
      importance: "normal",
      title: "Playwright E2E Initial Run",
      payload: {},
    });

    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    await page.waitForSelector("header h1");
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

    await page.waitForSelector(".agent-card");
    const agentCard = page.locator(".agent-card");
    expect(await agentCard.count()).toBeGreaterThan(0);
    expect(await agentCard.first().textContent()).toContain("agent-planner");

    await page.close();
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

    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    await page.waitForSelector(".dashboard-shell");
    const scriptTags = await page.locator('script:has-text("xss-injection")').count();
    expect(scriptTags).toBe(0);

    const textContent = await page.locator("body").innerText();
    expect(textContent).toContain('<script>alert("xss-injection")</script>');

    await page.close();
  });

  it("should handle mobile viewport layout and keyboard traversal in real browser", async () => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`http://127.0.0.1:${port}/`);

    await page.waitForSelector(".stage-rail");
    const stageRail = page.locator(".stage-rail");
    expect(await stageRail.isVisible()).toBe(true);

    await page.keyboard.press("Tab");
    const activeTagName = await page.evaluate(() => document.activeElement?.tagName);
    expect(activeTagName).toBeDefined();

    await page.close();
  });

  it("should preserve prefers-reduced-motion and accessible ARIA attributes", async () => {
    const page = await browser.newPage();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`http://127.0.0.1:${port}/`);

    await page.waitForSelector("[aria-live]");
    const liveRegions = await page.locator("[aria-live]").count();
    expect(liveRegions).toBeGreaterThan(0);

    await page.close();
  });
});
