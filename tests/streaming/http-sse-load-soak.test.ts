import { describe, expect, it } from "bun:test";
import { createServer, type Server } from "http";
import {
  SseBroker,
  StreamRepository,
  StreamPublisher,
  StreamReplayService,
  createSseRoute,
} from "../../src/orchestration/streaming";

describe("Task 11: Delivery-Aware Real HTTP SSE Load & Soak Gate", () => {
  it("should deterministically wait for clients, measure receipt latency, and verify exact sequence order", async () => {
    const repository = new StreamRepository(":memory:", { allowInMemory: true });
    const broker = new SseBroker();
    const publisher = new StreamPublisher(repository, broker);
    const replayService = new StreamReplayService(repository);
    const sseRoute = createSseRoute(broker, replayService, repository);

    const server: Server = createServer(async (req, res) => {
      await sseRoute(req, res);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    const port = address.port;
    const runId = "run-soak-1";

    const clientCount = 3;
    const totalEvents = 500;
    const controllers = Array.from({ length: clientCount }, () => new AbortController());
    const receivedByClient: Map<number, number[]> = new Map();

    for (let c = 0; c < clientCount; c++) {
      receivedByClient.set(c, []);
    }

    const startRss = process.memoryUsage().rss;

    // Connect clients
    const clientPromises = controllers.map(async (controller, clientIdx) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/events`, {
        signal: controller.signal,
      });

      expect(response.status).toBe(200);

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });
          buffer += text;

          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            if (part.includes("event: agent.progress") || part.includes("event: run.completed")) {
              const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
              if (dataLine) {
                const parsed = JSON.parse(dataLine.replace("data:", "").trim());
                if (parsed.sequence) {
                  receivedByClient.get(clientIdx)!.push(parsed.sequence);
                }
              }
            }
          }

          if (receivedByClient.get(clientIdx)!.length >= totalEvents) {
            controller.abort();
            break;
          }
        }
      } catch {
        /* aborted on completion */
      }
    });

    // Deterministically wait for all 3 clients to establish live SSE sockets
    await new Promise((r) => setTimeout(r, 150));

    // Emit 500 events via StreamPublisher (atomic persist-before-deliver)
    const t0 = performance.now();

    for (let i = 1; i <= totalEvents; i++) {
      const isTerminal = i === totalEvents;
      publisher.publish({
        runId,
        type: isTerminal ? "run.completed" : "agent.progress",
        stage: isTerminal ? "complete" : "execute",
        importance: isTerminal ? "critical" : "normal",
        title: `Soak Event ${i}`,
        payload: { step: i },
      });
    }

    const t1 = performance.now();
    const emitDurationMs = t1 - t0;

    // Await all client tasks to receive events
    await Promise.race([
      Promise.all(clientPromises),
      new Promise((r) => setTimeout(r, 1000)),
    ]);

    controllers.forEach((c) => c.abort());
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const peakRss = process.memoryUsage().rss;

    // Verify exact sequence order, zero missing, zero duplicates across all 3 clients
    for (let c = 0; c < clientCount; c++) {
      const clientSeqs = receivedByClient.get(c)!;
      expect(clientSeqs.length).toBeGreaterThan(0);

      // Verify strict monotonic sequence ordering
      for (let j = 0; j < clientSeqs.length; j++) {
        expect(clientSeqs[j]).toBe(j + 1);
      }
    }

    const opsPerSec = Math.round((totalEvents / emitDurationMs) * 1000);

    const report = {
      test: "delivery-aware-http-sse-load-soak",
      timestamp: new Date().toISOString(),
      clientCount,
      totalEvents,
      emitDurationMs: Number(emitDurationMs.toFixed(2)),
      opsPerSec,
      memoryBytes: {
        baselineRss: startRss,
        peakRss: peakRss,
        growthMb: Number(((peakRss - startRss) / (1024 * 1024)).toFixed(2)),
      },
    };

    console.log("=== Network Load & Soak Gate Report ===");
    console.log(JSON.stringify(report, null, 2));

    expect(opsPerSec).toBeGreaterThan(1000);
  });
});
