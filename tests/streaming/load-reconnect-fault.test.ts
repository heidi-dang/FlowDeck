import { describe, expect, it } from "bun:test";
import {
  BackpressureController,
  EventCoalescer,
  FlowDeckStreamEvent,
  SSEParser,
  SequenceTracker,
  SequenceValidator,
  SseSession,
  StreamRepository,
  createStreamEvent,
} from "../../src/orchestration/streaming";

describe("Task 8: Load, Reconnect, and Fault Hardening", () => {
  it("should process high-rate event bursts and apply token/metric coalescing correctly", () => {
    const coalescer = new EventCoalescer();
    const events: FlowDeckStreamEvent[] = [];

    // Create a batch of rapid events
    for (let i = 1; i <= 20; i++) {
      events.push(
        createStreamEvent({
          eventId: `evt-token-${i}`,
          sequence: i,
          runId: "run-burst-1",
          type: "model.first_token",
          stage: "execute",
          importance: "debug",
          title: `Token ${i}`,
          payload: { token: `w${i}` },
        }),
      );
    }
    // High importance state transition event
    events.push(
      createStreamEvent({
        eventId: "evt-state-complete",
        sequence: 21,
        runId: "run-burst-1",
        type: "stage.completed",
        stage: "execute",
        importance: "important",
        title: "Stage Complete",
        payload: {},
      }),
    );

    const coalesced = coalescer.coalesce(events);
    expect(coalesced.length).toBeGreaterThan(0);
    expect(coalesced.some((e) => e.type === "stage.completed")).toBe(true);
  });

  it("should enforce monotonic sequences and reject duplicate or out-of-order events", () => {
    const validator = new SequenceValidator();
    const runId = "run-seq-fault";

    expect(validator.validate(runId, 1)).toEqual({ valid: true });
    expect(validator.validate(runId, 2)).toEqual({ valid: true });

    // Duplicate sequence
    const dupRes = validator.validate(runId, 2);
    expect(dupRes.valid).toBe(false);
    expect(dupRes.error).toContain("Duplicate sequence");

    // Sequence gap
    const gapRes = validator.validate(runId, 10);
    expect(gapRes.valid).toBe(false);
    expect(gapRes.error).toContain("Gap detected");
  });

  it("should handle sequence tracking and deduplication", () => {
    const tracker = new SequenceTracker();

    expect(tracker.track("evt-1", 1)).toBe(true); // First arrival: processed
    expect(tracker.track("evt-1", 1)).toBe(false); // Duplicate: filtered out
    expect(tracker.track("evt-2", 2)).toBe(true);

    // After snapshot, duplicate state is reset
    tracker.handleSnapshot();
    expect(tracker.track("evt-1", 1)).toBe(true);
  });

  it("should apply backpressure and buffer events for SSE session", () => {
    const mockRes = {
      written: [] as string[],
      write(msg: string) {
        this.written.push(msg);
      },
      end() {},
    };
    const session = new SseSession(mockRes, "client-1");
    const bp = new BackpressureController(session);

    const evt = createStreamEvent({
      eventId: "e1",
      sequence: 1,
      runId: "run-bp",
      type: "agent.progress",
      stage: "execute",
      importance: "normal",
      title: "Progress",
      payload: {},
    });

    bp.enqueue(evt);
    expect(mockRes.written.length).toBe(1);
    expect(mockRes.written[0]).toContain("event: agent.progress");
  });

  it("should handle multiline chunked SSE stream parsing under network packet fragmentation", () => {
    const parser = new SSEParser();
    const fragments = [
      "id: evt-",
      "100\nevent: stage.",
      "completed\ndata: {\"schemaVersion\":1,\"sequence\":100,",
      "\"title\":\"Done\"}\n\n",
    ];

    const parsed: Array<{ id?: string; event?: string; data?: string }> = [];

    for (const chunk of fragments) {
      parser.parseChunk(chunk, (msg) => parsed.push(msg));
    }

    expect(parsed.length).toBe(1);
    expect(parsed[0].id).toBe("evt-100");
    expect(parsed[0].event).toBe("stage.completed");
    expect(parsed[0].data).toContain('"sequence":100');
  });

  it("should handle sustained 10,000 event streaming load with stable memory footprint", () => {
    const repo = new StreamRepository();
    const validator = new SequenceValidator();
    const tracker = new SequenceTracker(5000);
    const runId = "run-soak-10k";

    const memBefore = process.memoryUsage().heapUsed;
    const startTime = Date.now();

    for (let i = 1; i <= 10000; i++) {
      const isTerminal = i === 10000;
      const type = isTerminal ? "run.completed" : (i % 10 === 0 ? "metrics.updated" : "agent.progress");
      const event = createStreamEvent({
        eventId: `evt-10k-${i}`,
        sequence: i,
        runId,
        type,
        stage: isTerminal ? "complete" : "execute",
        importance: isTerminal ? "critical" : "normal",
        title: `Event ${i}`,
        payload: { step: i },
      });

      // Persist-before-deliver check
      repo.persistEvent(runId, i, event.eventId, event, Date.now());
      // Sequence validation
      const valid = validator.validate(runId, i);
      expect(valid.valid).toBe(true);
      // Deduplication check
      const tracked = tracker.track(event.eventId, i);
      expect(tracked).toBe(true);
    }

    const duration = Date.now() - startTime;
    const memAfter = process.memoryUsage().heapUsed;
    const memDiffMb = (memAfter - memBefore) / (1024 * 1024);

    expect(duration).toBeLessThan(5000); // 10k events processed in < 5s
    expect(memDiffMb).toBeLessThan(50); // memory growth < 50 MB
  });
});
