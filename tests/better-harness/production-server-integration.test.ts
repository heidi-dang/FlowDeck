import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { HarnessHttpServer } from "../../src/better-harness/transport/http-server";
import { SseManager } from "../../src/better-harness/transport/sse";
import { EventBus } from "../../src/better-harness/runtime/event-bus";
import type { RouterContext } from "../../src/better-harness/runtime/router-context";
import { StreamRepository } from "../../src/orchestration/streaming";

describe("Production Harness Server SSE Integration Gate", () => {
  let server: HarnessHttpServer;
  let sseManager: SseManager;
  let repository: StreamRepository;
  let port: number;

  beforeAll(async () => {
    const eventBus = new EventBus();
    repository = new StreamRepository(":memory:", { allowInMemory: true });
    sseManager = new SseManager(eventBus, repository);

    const routerCtx: Partial<RouterContext> = {
      resolveProjectPath: () => "/tmp",
      sseManager,
    };

    server = new HarnessHttpServer({
      enabled: true,
      bindHost: "127.0.0.1",
      port: 0,
    });

    server.setSseManager(sseManager);
    server.setRouterContext(routerCtx as RouterContext);

    port = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("should serve production dashboard UI route with HTTP 200, CSP headers, and landmark elements", async () => {
    const uiUrl = `http://127.0.0.1:${port}/app`;
    const response = await fetch(uiUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toBeTruthy();
    const html = await response.text();
    expect(html).toContain('<header role="banner">');
    expect(html).toContain('id="live-dashboard"');
  });

  it("should enforce fail-closed auth on non-loopback interface", async () => {
    const authServer = new HarnessHttpServer({
      enabled: true,
      bindHost: "0.0.0.0",
      port: 0,
      auth: { enabled: true, token: "secret-token-123" },
    });
    authServer.setSseManager(sseManager);
    const authPort = await authServer.start();

    try {
      const unauthorizedRes = await fetch(`http://127.0.0.1:${authPort}/api/v1/servers/s1/projects/p1/better-harness/runs/r1/events`);
      expect(unauthorizedRes.status).toBe(401);

      const controller = new AbortController();
      const authorizedRes = await fetch(`http://127.0.0.1:${authPort}/api/v1/servers/s1/projects/p1/better-harness/runs/r1/events`, {
        headers: { Authorization: "Bearer secret-token-123" },
        signal: controller.signal,
      });
      expect(authorizedRes.status).toBe(200);
      controller.abort();
    } finally {
      await authServer.stop();
    }
  });

  it("should deliver complete canonical envelope, eventId, runId, and exact sequence via SSE route", async () => {
    const runId = "run-prod-integration-1";
    const serverKey = "srv-prod-1";
    const projectKey = "proj-prod-1";

    const controller = new AbortController();
    const sseUrl = `http://127.0.0.1:${port}/api/v1/servers/${serverKey}/projects/${projectKey}/better-harness/runs/${runId}/events`;

    const responsePromise = fetch(sseUrl, { signal: controller.signal });

    // Emit event via SseManager (uses canonical StreamPublisher)
    sseManager.broadcastEvent({
      type: "run.started",
      timestamp: new Date().toISOString(),
      data: { runId, title: "Production Harness Integration Run" },
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";

    for (let i = 0; i < 10; i++) {
      const { done, value } = (await reader?.read()) || {};
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("data:") && text.includes("run.started")) break;
    }

    controller.abort();

    expect(text).toContain(": connected");
    expect(text).toContain("event: run.started");

    const match = text.match(/data: ({.*?run\.started.*?})(\n|$)/);
    expect(match).toBeTruthy();
    if (match) {
      const parsed = JSON.parse(match[1]);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.eventId).toBeTruthy();
      expect(parsed.runId).toBe(runId);
      expect(parsed.sequence).toBeGreaterThanOrEqual(1);
      expect(parsed.type).toBe("run.started");
    }

    // Verify SQLite events and event_outbox rows exist in database
    const db = repository.getDb();
    const eventRow = db.query("SELECT * FROM events WHERE aggregate_id = ?").get(runId) as any;
    expect(eventRow).toBeTruthy();
    expect(eventRow.aggregate_version).toBeGreaterThanOrEqual(1);

    const outboxRow = db.query("SELECT * FROM event_outbox WHERE aggregate_id = ?").get(runId) as any;
    expect(outboxRow).toBeTruthy();
    expect(outboxRow.status).toBe("pending");
  });

  it("should support reconnect using Last-Event-ID header and replay missed events", async () => {
    const runId = "run-prod-reconnect-1";
    sseManager.broadcastEvent({
      type: "run.started",
      timestamp: new Date().toISOString(),
      data: { runId, title: "Initial Run" },
    });
    const evt2 = sseManager.getPublisher().publish({
      runId,
      type: "agent.progress",
      stage: "execute",
      importance: "normal",
      title: "Step 2",
      payload: { step: 2 },
    });

    const sseUrl = `http://127.0.0.1:${port}/api/runs/${runId}/events`;
    const controller = new AbortController();
    const response = await fetch(sseUrl, {
      headers: { "Last-Event-ID": "1" },
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";

    for (let i = 0; i < 5; i++) {
      const { done, value } = (await reader?.read()) || {};
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes(`id: ${evt2.sequence}`)) break;
    }

    controller.abort();
    expect(text).toContain(`id: ${evt2.sequence}`);
    expect(text).toContain("agent.progress");
  });
});
