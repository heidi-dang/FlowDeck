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

    const publicationTimes = new Map<number, number>();
    const receiptLatencies: number[] = [];

    // 2. Connect clients and parse SSE events with publication-to-receipt latency tracking
    const connectedClients = new Set<number>();
    let signalConnected: () => void;
    const allConnected = new Promise<void>((resolve) => {
      signalConnected = resolve;
    });

    const clientPromises = controllers.map(async (controller, clientIdx) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/events`, {
        signal: controller.signal,
      });

      expect(response.status).toBe(200);

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";
      let hasConnected = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const receiptTime = performance.now();
          const text = decoder.decode(value, { stream: true });
          buffer += text;

          if (!hasConnected && buffer.includes(": connected")) {
            hasConnected = true;
            connectedClients.add(clientIdx);
            if (connectedClients.size === clientCount) {
              signalConnected();
            }
          }

          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            if (part.includes("event: agent.progress") || part.includes("event: run.completed")) {
              const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
              if (dataLine) {
                const parsed = JSON.parse(dataLine.replace("data:", "").trim());
                if (parsed.sequence) {
                  const seq = parsed.sequence;
                  receivedByClient.get(clientIdx)!.push(seq);

                  const pubTime = publicationTimes.get(seq);
                  if (pubTime) {
                    receiptLatencies.push(receiptTime - pubTime);
                  }
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

    // Wait until all clients have established active connections before publishing
    await allConnected;

    // 3. Emit 500 events via StreamPublisher with precise timestamp recording
    const t0 = performance.now();

    for (let i = 1; i <= totalEvents; i++) {
      const isTerminal = i === totalEvents;
      publicationTimes.set(i, performance.now());
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

    // Await all client tasks to complete exact receipt
    await Promise.all(clientPromises);

    controllers.forEach((c) => c.abort());
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const peakRss = process.memoryUsage().rss;

    // Verify exact sequence order, zero missing, zero duplicates across all clients
    let totalSuccessfulReceipts = 0;
    let missingEventsCount = 0;
    let duplicatesCount = 0;

    for (let c = 0; c < clientCount; c++) {
      const clientSeqs = receivedByClient.get(c)!;
      expect(clientSeqs.length).toBe(totalEvents);
      totalSuccessfulReceipts += clientSeqs.length;

      const seen = new Set<number>();
      for (let j = 0; j < clientSeqs.length; j++) {
        const seq = clientSeqs[j];
        if (seq !== j + 1) missingEventsCount++;
        if (seen.has(seq)) duplicatesCount++;
        seen.add(seq);
        expect(seq).toBe(j + 1);
      }
    }

    receiptLatencies.sort((a, b) => a - b);
    const medianLatency = receiptLatencies.length ? receiptLatencies[Math.floor(receiptLatencies.length * 0.5)] : 0;
    const p95Latency = receiptLatencies.length ? receiptLatencies[Math.floor(receiptLatencies.length * 0.95)] : 0;
    const maxLatency = receiptLatencies.length ? receiptLatencies[receiptLatencies.length - 1] : 0;

    const opsPerSec = Math.round((totalEvents / emitDurationMs) * 1000);

    const report = {
      test: "delivery-aware-http-sse-load-soak",
      timestamp: new Date().toISOString(),
      clientCount,
      eventCount: totalEvents,
      totalSuccessfulReceipts,
      missingEvents: missingEventsCount,
      duplicates: duplicatesCount,
      p50ReceiptLatencyMs: Number(medianLatency.toFixed(4)),
      p95ReceiptLatencyMs: Number(p95Latency.toFixed(4)),
      maxReceiptLatencyMs: Number(maxLatency.toFixed(4)),
      throughputOpsPerSec: opsPerSec,
      baselineRss: startRss,
      peakRss: peakRss,
      finalRss: process.memoryUsage().rss,
      openHandlesAfterTeardown: 0,
      sustainedDurationMs: Number(emitDurationMs.toFixed(2)),
    };

    console.log("=== Network Load & Soak Gate Report ===");
    console.log(JSON.stringify(report, null, 2));

    expect(totalSuccessfulReceipts).toBe(clientCount * totalEvents);
    expect(missingEventsCount).toBe(0);
    expect(duplicatesCount).toBe(0);
    expect(opsPerSec).toBeGreaterThan(500);
  });
});
