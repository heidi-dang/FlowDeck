import { describe, it, expect } from "bun:test"
import {
  CallTimer,
  RuntimeStopwatch,
  callTimers,
  getCallTimer,
  releaseCallTimer,
  buildLatencyBreakdown,
  TIMING_BASED_ON,
} from "../src/services/real-time-instrument"

describe("REAL-TIME INSTRUMENTATION", () => {
  it("is explicitly based on performance.now (a real monotonic clock)", () => {
    expect(TIMING_BASED_ON).toBe("performance.now")
  })

  it("phase output reflects real measured latency, never hardcoded constants", async () => {
    // The old defect passed constants like governance=0.05 / loop_guard=0.03.
    // Give each phase a genuine measured pause so the reported values are real
    // elapsed time and provably NOT the old synthetic constants.
    const t = new CallTimer()
    t.start("governance")
    await new Promise((r) => setTimeout(r, 20))
    t.start("loop_guard")
    await new Promise((r) => setTimeout(r, 20))
    t.start("post_processing")
    await new Promise((r) => setTimeout(r, 20))
    t.end()
    for (const p of t.phases()) {
      // Real elapsed times at the 20ms scale can never legitimately equal the
      // old synthetic constants (0.05 / 0.03 / 0.1 ms).
      expect(p.ms).not.toBe(0.05)
      expect(p.ms).not.toBe(0.03)
      expect(p.ms).not.toBe(0.1)
    }
    expect(t.totalMs()).toBeGreaterThanOrEqual(55) // three ~20ms pauses
  })

  it("CallTimer phases are >= 0, monotonic and derived from real elapsed time", async () => {
    const t = new CallTimer()
    t.start("a")
    await new Promise((r) => setTimeout(r, 50))
    t.start("b")
    await new Promise((r) => setTimeout(r, 10))
    t.end()

    const phases = t.phases()
    expect(phases.length).toBe(2)
    for (const p of phases) {
      expect(p.ms).toBeGreaterThanOrEqual(0)
    }
    // Phase "a" measured a ~50ms real pause → elapsed must be at least ~45ms.
    expect(phases[0].ms).toBeGreaterThanOrEqual(45)
    expect(phases[1].ms).toBeGreaterThanOrEqual(0)
    expect(t.totalMs()).toBeGreaterThanOrEqual(t.phases()[0].ms)
  })

  it("minor phases that should be near-zero never exceed the slow phase", async () => {
    // Phases are individually monotonic: a short 5ms phase must not report more
    // than a measured ~100ms pause.
    const t = new CallTimer()
    t.start("governance")
    await new Promise((r) => setTimeout(r, 5))
    t.start("post_processing")
    await new Promise((r) => setTimeout(r, 100))
    t.end()
    const phases = t.phases()
    expect(phases[0].ms).toBeLessThanOrEqual(phases[1].ms + 1)
  })

  it("RuntimeStopwatch snapshot matches real measured values", async () => {
    const sw = new RuntimeStopwatch()
    sw.mark("governance")
    await new Promise((r) => setTimeout(r, 40))
    sw.mark("loop_guard")
    await new Promise((r) => setTimeout(r, 40))
    sw.mark("post_processing")

    const snap = sw.snapshot()
    expect(snap.length).toBe(3)
    expect(snap[0].ms).toBeGreaterThanOrEqual(0)
    // Monotonic cumulative laps: each later mark's elapsed >= the prior.
    expect(snap[1].ms).toBeGreaterThanOrEqual(snap[0].ms + 35)
    expect(snap[2].ms).toBeGreaterThanOrEqual(snap[1].ms + 35)
    expect(sw.totalMs()).toBeGreaterThanOrEqual(75)
  })

  it("buildLatencyBreakdown is a compatible formatting helper", () => {
    const out = buildLatencyBreakdown([["governance", 0.05], ["loop_guard", 0.03], ["post_processing", 0.1]])
    expect(out).toEqual([
      { name: "governance", ms: 0.05 },
      { name: "loop_guard", ms: 0.03 },
      { name: "post_processing", ms: 0.1 },
    ])
  })

  it("registry lazily creates, reuses and releases per (session, call, tool) timers", () => {
    const a = getCallTimer("s1", "c1", "write")
    const b = getCallTimer("s1", "c1", "write")
    expect(a).toBe(b)
    expect(callTimers.size).toBeGreaterThanOrEqual(1)

    // A different tool is a different timer.
    const c = getCallTimer("s1", "c1", "edit")
    expect(c).not.toBe(a)

    a.start("governance")
    a.end()
    releaseCallTimer("s1", "c1", "write")
    expect(callTimers.has("s1|c1|write")).toBe(false)
    // After release a fresh timer comes back.
    const d = getCallTimer("s1", "c1", "write")
    expect(d).not.toBe(a)
    expect(d.phases().length).toBe(0)
  })
})