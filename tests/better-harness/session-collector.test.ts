import { describe, it, expect } from "vitest";
import { readSessionRecords } from "../../src/better-harness/opencode/session-reader";
import { analyzeSessions } from "../../src/better-harness/opencode/session-analyzer";

describe("Session Reader", () => {
  it("returns empty array for non-existent directory", () => {
    const records = readSessionRecords("/nonexistent/path");
    expect(records).toEqual([]);
  });
});

describe("Session Analyzer", () => {
  it("handles empty records", () => {
    const analysis = analyzeSessions([]);
    expect(analysis.totalSessions).toBe(0);
    expect(analysis.longSessions).toBe(0);
    expect(analysis.failedSessions).toBe(0);
    expect(analysis.patterns).toEqual([]);
  });

  it("detects long sessions", () => {
    const analysis = analyzeSessions([
      { id: "s1", startTime: "", status: "completed" as const, toolCalls: 10, errors: [], events: [], durationMs: 500_000 },
    ]);
    expect(analysis.longSessions).toBe(1);
    expect(analysis.patterns.length).toBeGreaterThan(0);
  });

  it("detects failed sessions", () => {
    const analysis = analyzeSessions([
      { id: "s1", startTime: "", status: "failed" as const, toolCalls: 5, errors: ["err1"], events: [], durationMs: 10_000 },
    ]);
    expect(analysis.failedSessions).toBe(1);
  });

  it("detects permission interruptions", () => {
    const analysis = analyzeSessions([
      {
        id: "s1", startTime: "", status: "completed" as const, toolCalls: 3, errors: [], durationMs: 1000,
        events: [{ type: "permission.block", timestamp: "t1" }],
      },
    ]);
    expect(analysis.permissionInterruptions).toBe(1);
  });

  it("detects compactions", () => {
    const analysis = analyzeSessions([
      {
        id: "s1", startTime: "", status: "completed" as const, toolCalls: 3, errors: [], durationMs: 1000,
        events: [{ type: "compaction", timestamp: "t1" }],
      },
    ]);
    expect(analysis.compactions).toBe(1);
  });
});
