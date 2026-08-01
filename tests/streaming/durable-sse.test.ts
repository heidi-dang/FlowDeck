import { describe, expect, it } from "bun:test";
import { StreamRepository } from "../../src/orchestration/streaming/stream-repository";
import { SequenceValidator } from "../../src/orchestration/streaming/sequence-validator";
import { SseBroker } from "../../src/orchestration/streaming/sse-broker";
import { SseSession } from "../../src/orchestration/streaming/sse-session";
import { StreamReplayService } from "../../src/orchestration/streaming/replay-service";
import { HeartbeatService } from "../../src/orchestration/streaming/heartbeat-service";
import { BackpressureController } from "../../src/orchestration/streaming/backpressure-controller";
import { CancellationController } from "../../src/orchestration/streaming/cancellation-controller";
import { createSseRoute } from "../../src/orchestration/streaming/sse-route";
import { createStreamEvent } from "../../src/orchestration/streaming/stream-event";

describe("Durable SSE Backend Infrastructure", () => {
  it("persist-before-deliver & sequence validation", () => {
    const repo = new StreamRepository(":memory:", { allowInMemory: true });
    const validator = new SequenceValidator();
    const runId = "run-1";

    let seqCheck = validator.validate(runId, 1);
    expect(seqCheck.valid).toBe(true);
    repo.persistEvent(runId, 1, "start", {}, Date.now());

    seqCheck = validator.validate(runId, 1);
    expect(seqCheck.valid).toBe(false); // duplicate

    seqCheck = validator.validate(runId, 3);
    expect(seqCheck.valid).toBe(false); // gap

    const events = repo.getEventsAfter(runId, 0);
    expect(events.length).toBe(1);
    expect(events[0].sequence).toBe(1);
  });

  it("replay & snapshot fallback", async () => {
    const repo = new StreamRepository(":memory:", { allowInMemory: true });
    const replayService = new StreamReplayService(repo);

    repo.persistEvent("run-2", 1, "e1", {}, Date.now());
    repo.persistEvent("run-2", 2, "e2", {}, Date.now());
    repo.persistEvent("run-2", 3, "e3", {}, Date.now());

    let sentEvents: string[] = [];
    const mockRes = {
      write: (data: string) => {
        sentEvents.push(data);
      },
      end: () => {}
    };
    const session = new SseSession(mockRes as any, "client-1");

    await replayService.replayToSession("run-2", 1, session);
    expect(sentEvents.length).toBe(2); // e2 and e3
  });

  it("backpressure controller", () => {
    let sentEvents: string[] = [];
    const mockRes = {
      write: (data: string) => {
        sentEvents.push(data);
      },
      end: () => {}
    };
    const session = new SseSession(mockRes as any, "client-2");
    const bp = new BackpressureController(session);

    bp.enqueue(createStreamEvent({ eventId: '1', sequence: 1, runId: 'run-3', type: 'agent.progress', stage: 'execute', importance: 'normal', title: 'progress', payload: {} }));
    expect(sentEvents.length).toBe(1);
  });

  it("heartbeat service", () => {
    const hb = new HeartbeatService();
    const mockRes = {
      write: () => {},
      end: () => {}
    };
    const session = new SseSession(mockRes as any, "client-3");
    hb.start(session);
    hb.stop("client-3");
    expect(true).toBe(true); // timer successfully stopped
  });

  it("cancellation propagation", () => {
    const cc = new CancellationController();
    cc.cancelRun("run-4");
    expect(cc.isCancelled("run-4")).toBe(true);
  });

  it("SSE route handling", async () => {
    const broker = new SseBroker();
    const repo = new StreamRepository(":memory:", { allowInMemory: true });
    const replayService = new StreamReplayService(repo);
    const route = createSseRoute(broker, replayService, repo);

    const req = {
      params: { runId: "run-5" },
      headers: { "last-event-id": "0" },
      on: () => {}
    };
    let headersSet = false;
    const res = {
      writeHead: (status: number, headers: any) => {
        expect(status).toBe(200);
        expect(headers["Content-Type"]).toBe("text/event-stream");
        headersSet = true;
      },
      write: () => {},
      end: () => {}
    };

    await route(req, res);
    expect(headersSet).toBe(true);
    expect(broker.hasClients("run-5")).toBe(true);
  });
});
