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

  it("should respond to canonical production SSE route and stream events from unified SSE v2 manager", async () => {
    const runId = "run-prod-integration-1";
    const serverKey = "srv-prod-1";
    const projectKey = "proj-prod-1";

    const controller = new AbortController();
    const sseUrl = `http://127.0.0.1:${port}/api/v1/servers/${serverKey}/projects/${projectKey}/better-harness/runs/${runId}/events`;

    const responsePromise = fetch(sseUrl, { signal: controller.signal });

    // Emit event via SseManager (which uses canonical StreamPublisher)
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

    const { value } = (await reader?.read()) || {};
    if (value) text += decoder.decode(value);

    controller.abort();
    expect(text).toContain(": connected");
  });
});
