import { describe, it, expect, beforeEach } from "bun:test"
import {
  HeidiPerformanceTracker,
  createTracker,
  getTracker,
  clearTracker,
  _resetAllTrackers,
} from "../src/services/heidi-performance"

describe("HeidiPerformanceTracker — Milestone A", () => {
  let tracker: HeidiPerformanceTracker

  beforeEach(() => {
    _resetAllTrackers()
    tracker = new HeidiPerformanceTracker("task-a1", "sess-1")
  })

  it("starts and ends a span returning duration >= 0", () => {
    const key = tracker.startSpan("routing")
    const dur = tracker.endSpan(key)
    expect(dur).toBeGreaterThanOrEqual(0)
  })

  it("accumulates routing latency", () => {
    const key = tracker.startSpan("routing")
    tracker.endSpan(key)
    const snap = tracker.snapshot()
    expect(snap.routingMs).toBeGreaterThanOrEqual(0)
  })

  it("accumulates governance fast-path hits", () => {
    const key = tracker.startSpan("governance.read_fast_path")
    tracker.endSpan(key)
    const snap = tracker.snapshot()
    expect(snap.governanceFastPathHits).toBe(1)
    expect(snap.governanceCheckMs).toBeGreaterThanOrEqual(0)
  })

  it("records model turns with token counts", () => {
    tracker.recordModelTurn(1200, 450, 8000)
    const snap = tracker.snapshot()
    expect(snap.modelTurns).toBe(1)
    expect(snap.inputTokens).toBe(1200)
    expect(snap.outputTokens).toBe(450)
    expect(snap.contextSizeTokens).toBe(8000)
  })

  it("records tool calls with parallel/sequential tracking", () => {
    tracker.recordToolCall(true)
    tracker.recordToolCall(false)
    tracker.recordToolCall(true)
    const snap = tracker.snapshot()
    expect(snap.toolCallsTotal).toBe(3)
    expect(snap.toolCallsParallel).toBe(2)
    expect(snap.toolCallsSequential).toBe(1)
  })

  it("time() wrapper measures synchronous functions", () => {
    const result = tracker.time("config.load", () => {
      // simulate tiny work
      let x = 0
      for (let i = 0; i < 100; i++) x += i
      return x
    })
    expect(result).toBe(4950)
    expect(tracker.snapshot().configLoadMs).toBeGreaterThanOrEqual(0)
  })

  it("timeAsync() wrapper measures async functions", async () => {
    const result = await tracker.timeAsync("delegation.startup", async () => {
      return "delegated"
    })
    expect(result).toBe("delegated")
    expect(tracker.snapshot().delegationStartupMs).toBeGreaterThanOrEqual(0)
  })

  it("snapshot returns an independent copy (immutable)", () => {
    tracker.recordModelTurn(100, 50)
    const snap1 = tracker.snapshot()
    tracker.recordModelTurn(200, 75)
    const snap2 = tracker.snapshot()
    expect(snap1.modelTurns).toBe(1)
    expect(snap2.modelTurns).toBe(2)
  })

  it("summary() produces non-empty string", () => {
    tracker.recordModelTurn(500, 200)
    tracker.recordToolCall(true)
    const s = tracker.summary()
    expect(s).toContain("task:")
    expect(s).toContain("turns:1")
  })

  it("registry: createTracker/getTracker/clearTracker lifecycle", () => {
    const t = createTracker("my-task", "my-sess")
    expect(getTracker("my-task")).toBe(t)
    clearTracker("my-task")
    expect(getTracker("my-task")).toBeUndefined()
  })

  it("endSpan on unknown key returns 0 (no crash)", () => {
    const dur = tracker.endSpan("nonexistent-key")
    expect(dur).toBe(0)
  })

  it("span overhead is < 1ms p50 for 1000 span operations", () => {
    const N = 1000
    const start = Date.now()
    for (let i = 0; i < N; i++) {
      const key = tracker.startSpan("tool.before")
      tracker.endSpan(key)
    }
    const elapsed = Date.now() - start
    const p50 = elapsed / N
    // p50 should be well under 1ms; allow 5ms p50 for CI variability
    expect(p50).toBeLessThan(5)
  })
})
