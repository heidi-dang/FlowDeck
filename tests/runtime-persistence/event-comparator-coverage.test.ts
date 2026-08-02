import { describe, it, expect } from "bun:test";
import {
  validateEventOrder,
  validateReproducibility,
  compareTraces,
  getMismatchDiagnostics,
} from "@/orchestration/runtime/trace-replay/event-comparator.js";
import type { TraceEvent } from "@/orchestration/runtime/trace-replay/trace-schema.js";

function makeEvent(
  id: string,
  type: TraceEvent["type"],
  timestamp: number,
  error?: string,
): TraceEvent {
  return {
    id,
    type,
    timestamp,
    payload: { tool: "read", args: {} },
    error,
  };
}

describe("trace-replay event-comparator — Dev 2 coverage", () => {
  it("validateEventOrder accepts non-decreasing timestamps", () => {
    const original = [
      makeEvent("ev-1", "tool_called", 100),
      makeEvent("ev-2", "tool_result", 200),
    ];
    const replayed = [
      makeEvent("ev-1-replay", "tool_called", 100),
      makeEvent("ev-2-replay", "tool_result", 200),
    ];
    expect(validateEventOrder(original, replayed)).toBe(true);
  });

  it("validateEventOrder rejects out-of-order original trace", () => {
    const original = [
      makeEvent("ev-1", "tool_called", 200),
      makeEvent("ev-2", "tool_result", 100),
    ];
    const replayed = [
      makeEvent("ev-1-replay", "tool_called", 100),
      makeEvent("ev-2-replay", "tool_result", 200),
    ];
    expect(validateEventOrder(original, replayed)).toBe(false);
  });

  it("validateEventOrder rejects out-of-order replayed trace", () => {
    const original = [
      makeEvent("ev-1", "tool_called", 100),
      makeEvent("ev-2", "tool_result", 200),
    ];
    const replayed = [
      makeEvent("ev-1-replay", "tool_called", 200),
      makeEvent("ev-2-replay", "tool_result", 100),
    ];
    expect(validateEventOrder(original, replayed)).toBe(false);
  });

  it("validateEventOrder handles single-event traces", () => {
    const single = [makeEvent("ev-1", "tool_called", 100)];
    expect(validateEventOrder(single, [makeEvent("ev-1-replay", "tool_called", 100)])).toBe(true);
  });

  it("validateReproducibility rejects length mismatch", () => {
    const original = [makeEvent("ev-1", "tool_called", 100)];
    const replayed = [
      makeEvent("ev-1-replay", "tool_called", 100),
      makeEvent("ev-2-replay", "tool_result", 200),
    ];
    expect(validateReproducibility(original, replayed)).toBe(false);
  });

  it("validateReproducibility rejects type sequence mismatch", () => {
    const original = [
      makeEvent("ev-1", "tool_called", 100),
      makeEvent("ev-2", "tool_result", 200),
    ];
    const replayed = [
      makeEvent("ev-1-replay", "tool_called", 100),
      makeEvent("ev-2-replay", "tool_error", 200),
    ];
    expect(validateReproducibility(original, replayed)).toBe(false);
  });

  it("validateReproducibility accepts matching type sequence", () => {
    const original = [
      makeEvent("ev-1", "tool_called", 100),
      makeEvent("ev-2", "tool_result", 200),
    ];
    const replayed = [
      makeEvent("ev-1-replay", "tool_called", 100),
      makeEvent("ev-2-replay", "tool_result", 200),
    ];
    expect(validateReproducibility(original, replayed)).toBe(true);
  });

  it("compareTraces reports length mismatch with n/a ids", () => {
    const original = [makeEvent("ev-1", "tool_called", 100)];
    const replayed: TraceEvent[] = [];
    const result = compareTraces(original, replayed);
    expect(result.match).toBe(false);
    expect(result.differences.length).toBe(1);
    expect(result.differences[0].field).toBe("length");
    expect(result.differences[0].originalId).toBe("n/a");
    expect(result.differences[0].replayedId).toBe("n/a");
  });

  it("compareTraces reports type, timestamp and error mismatches per event", () => {
    const original = [makeEvent("ev-1", "tool_called", 100)];
    const replayed = [makeEvent("ev-1-replay", "tool_error", 500, "boom")];
    const result = compareTraces(original, replayed);
    expect(result.match).toBe(false);
    const fields = result.differences.map((d) => d.field);
    expect(fields).toContain("type");
    expect(fields).toContain("timestamp");
    expect(fields).toContain("error");
    expect(result.differences[0].originalId).toBe("ev-1");
    expect(result.differences[0].replayedId).toBe("ev-1-replay");
  });

  it("compareTraces treats equal undefined errors as a match", () => {
    const original = [makeEvent("ev-1", "tool_called", 100)];
    const replayed = [makeEvent("ev-1-replay", "tool_called", 100)];
    const result = compareTraces(original, replayed);
    expect(result.match).toBe(true);
    expect(result.differences.length).toBe(0);
  });

  it("getMismatchDiagnostics returns summary when traces match", () => {
    const original = [makeEvent("ev-1", "tool_called", 100)];
    const replayed = [makeEvent("ev-1-replay", "tool_called", 100)];
    expect(getMismatchDiagnostics(original, replayed)).toEqual(["Traces match exactly"]);
  });

  it("getMismatchDiagnostics lists every difference message", () => {
    const original = [makeEvent("ev-1", "tool_called", 100)];
    const replayed = [makeEvent("ev-1-replay", "tool_result", 100)];
    const diagnostics = getMismatchDiagnostics(original, replayed);
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]).toContain("type mismatch");
  });
});
