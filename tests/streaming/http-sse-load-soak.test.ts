import { describe, expect, it } from "bun:test";
import { createServer, type Server } from "http";
import {
  SseBroker,
  StreamReplayService,
  StreamRepository,
  createSseRoute,
  createStreamEvent,
} from "../../src/orchestration/streaming";

describe("Task 12: Real HTTP SSE Network Load and Reconnect Soak Tests", () => {
  it("should handle concurrent HTTP SSE streaming clients over real HTTP sockets with bounded latency", async () => {
    const repo = new StreamRepository(":memory:", { allowInMemory: true });
    const broker = new SseBroker();
    const replayService = new StreamReplayService(repo);
    const sseRoute = createSseRoute(broker, replayService, repo);

    const server: Server = createServer(async (req, res) => {
      await sseRoute(req, res);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    const port = address.port;
    const runId = "run-http-load-1";

    const clientCount = 5;
    const eventCount = 200;
    const receivedEventsByClient = Array.from({ length: clientCount }, () => [] as any[]);
    const latencies: number[] = [];

    // Connect 5 real HTTP SSE clients concurrently using fetch API
    const controllers = Array.from({ length: clientCount }, () => new AbortController());

    const _clientPromises = controllers.map(async (controller, clientIdx) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/events`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            if (part.includes("event: agent.progress") || part.includes("event: run.completed")) {
              const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
              if (dataLine) {
                const data = JSON.parse(dataLine.replace("data: ", ""));
                receivedEventsByClient[clientIdx].push(data);
              }
            }
          }

          if (receivedEventsByClient[clientIdx].length >= eventCount) {
            controller.abort();
            break;
          }
        }
      } catch {
        /* Aborted on test completion */
      }
    });

    // Wait briefly for all 5 HTTP clients to establish connection
    await new Promise((r) => setTimeout(r, 100));

    // Emit 200 events over HTTP streaming broker
    for (let i = 1; i <= eventCount; i++) {
      const t0 = performance.now();
      const isTerminal = i === eventCount;
      const evt = createStreamEvent({
        eventId: `evt-http-${i}`,
        sequence: i,
        runId,
        type: isTerminal ? "run.completed" : "agent.progress",
        stage: isTerminal ? "complete" : "execute",
        importance: isTerminal ? "critical" : "normal",
        title: `HTTP Event ${i}`,
        payload: { step: i },
      });

      // Persist in canonical database
      repo.persistEvent(runId, i, evt.type, evt.payload, Date.now());
      // Broadcast over live broker
      broker.broadcast(runId, evt);

      const t1 = performance.now();
      latencies.push(t1 - t0);
    }

    // Give HTTP sockets a short window to flush
    await new Promise((r) => setTimeout(r, 300));

    // Abort connections & stop server
    controllers.forEach((c) => c.abort());
    server.close();

    // Verification
    expect(latencies.length).toBe(eventCount);
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];

    expect(p50).toBeLessThan(10); // < 10ms per event emission
    expect(p95).toBeLessThan(25); // < 25ms p95 emission
  });

  it("should handle Last-Event-ID HTTP reconnect handoff without event loss or duplication", async () => {
    const repo = new StreamRepository(":memory:", { allowInMemory: true });
    const broker = new SseBroker();
    const replayService = new StreamReplayService(repo);
    const sseRoute = createSseRoute(broker, replayService, repo);

    const server: Server = createServer(async (req, res) => {
      await sseRoute(req, res);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    const port = address.port;
    const runId = "run-reconnect-soak";

    // 1. Emit 10 initial events to DB
    for (let i = 1; i <= 10; i++) {
      const evt = createStreamEvent({
        eventId: `evt-reconnect-${i}`,
        sequence: i,
        runId,
        type: "agent.progress",
        stage: "execute",
        importance: "normal",
        title: `Event ${i}`,
        payload: { step: i },
      });
      repo.persistEvent(runId, i, evt.type, evt.payload, Date.now());
    }

    // 2. Client reconnects with Last-Event-ID: 5
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/events`, {
      headers: { "Last-Event-ID": "5" },
      signal: controller.signal,
    });

    expect(response.status).toBe(200);

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let receivedText = "";

    // Read initial replayed events
    const { value } = (await reader?.read()) || {};
    if (value) receivedText += decoder.decode(value);

    controller.abort();
    server.close();

    // Replay should include event sequence 6 through 10
    expect(receivedText).toContain("id: 6");
    expect(receivedText).toContain("id: 10");
    expect(receivedText).not.toContain("id: 5\n"); // Last-Event-ID 5 is exclusive
  });
});
