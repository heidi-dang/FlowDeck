import { describe, it, expect } from "bun:test"
import { TokenBudgetController } from "../../src/services/token-budget-controller"
import { FileTokenUsageStore } from "../../src/services/token-usage-store"
import { resolveTokenBudgetConfig } from "../../src/config/token-budget-config"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

function measure(fn: () => void | Promise<void>): number {
  const start = performance.now()
  void fn()
  return performance.now() - start
}

function runBenchmark(name: string, iterations: number, fn: () => void, maxThresholdMs: number) {
  // Warmup.
  for (let i = 0; i < 3; i++) fn()

  const times: number[] = []
  for (let i = 0; i < iterations; i++) times.push(measure(fn))
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]
  const p95 = times[Math.floor(times.length * 0.95)]
  const maximum = times[times.length - 1]
  console.log(`[BENCHMARK] ${name}: median=${median.toFixed(2)}ms, p95=${p95.toFixed(2)}ms, max=${maximum.toFixed(2)}ms, threshold=${maxThresholdMs}ms`)
  // Enforce a generous hard limit to catch pathological regressions without flaky CI.
  expect(median).toBeLessThanOrEqual(maxThresholdMs)
}

describe("token-budget performance", () => {
  it("benchmarks 1,000 reserve+commit cycles (in-memory)", async () => {
    const cfg = resolveTokenBudgetConfig({
      enabled: true,
      profile: "normal",
      runTotal: 10_000_000,
      childTotal: 10_000_000,
    })
    const ctrl = new TokenBudgetController(cfg)
    // Warmup path.
    for (let i = 0; i < 10; i++) {
      const r = await ctrl.reserveRequest({
        runId: "run-bench", sessionId: "s", agentId: "a", requestId: `req-${i}`,
        estimatedInputTokens: 100, maxOutputTokens: 50,
      })
      if (r.allowed) {
        await ctrl.commitUsage({
          runId: "run-bench", sessionId: "s", agentId: "a", requestId: `req-${i}`,
          reservationId: r.reservationId, usage: { input: 60, output: 30 },
        })
      }
    }

    const start = performance.now()
    for (let i = 100; i < 1100; i++) {
      const r = await ctrl.reserveRequest({
        runId: "run-bench", sessionId: "s", agentId: "a", requestId: `req-${i}`,
        estimatedInputTokens: 100, maxOutputTokens: 50,
      })
      if (r.allowed) {
        await ctrl.commitUsage({
          runId: "run-bench", sessionId: "s", agentId: "a", requestId: `req-${i}`,
          reservationId: r.reservationId, usage: { input: 60, output: 30 },
        })
      }
    }
    const elapsed = performance.now() - start
    console.log(`[BENCHMARK] 1,000 reserve+commit cycles: total=${elapsed.toFixed(2)}ms`)
    expect(elapsed).toBeLessThanOrEqual(5_000)
  })

  it("benchmarks 1,000 durable appends (file store)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fd-bench-"))
    try {
      const store = new FileTokenUsageStore(dir)
      const start = performance.now()
      for (let i = 0; i < 1000; i++) {
        store.append("run-1", { kind: "reservation", reservationId: `res-${i}`, claimed: 100, status: "reserved" })
      }
      const elapsed = performance.now() - start
      console.log(`[BENCHMARK] 1,000 durable appends: total=${elapsed.toFixed(2)}ms`)
      expect(elapsed).toBeLessThanOrEqual(2_000)
      expect(store.read("run-1")).toHaveLength(1000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("benchmarks rebuild of 5,000 mixed records", () => {
    const entries: Array<Record<string, unknown>> = []
    for (let i = 0; i < 2500; i++) {
      entries.push({ kind: "reservation", reservationId: `res-${i}`, claimed: 500, status: "reserved" })
      entries.push({
        kind: "usage",
        runId: "run-1", sessionId: "s", agent: "a", requestId: `req-${i}`,
        reservationId: `res-${i}`, attempt: 1, input: 100, output: 50, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, billable: 150, status: "committed", recordedAt: new Date().toISOString(),
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { rebuildUsageEntries } = require("../../src/services/token-usage-store") as typeof import("../../src/services/token-usage-store")

    runBenchmark("rebuild 5,000 mixed records", 20, () => {
      rebuildUsageEntries(entries as never, "run-1")
    }, 200)
  })

  it("benchmarks concurrent reserve throughput under mutex", async () => {
    const cfg = resolveTokenBudgetConfig({
      enabled: true,
      profile: "normal",
      runTotal: 100_000_000,
      childTotal: 100_000_000,
    })
    const ctrl = new TokenBudgetController(cfg)
    const start = performance.now()
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        ctrl.reserveRequest({
          runId: "run-bench", sessionId: `s-${i % 8}`, agentId: "a", requestId: `req-${i}`,
          estimatedInputTokens: 100, maxOutputTokens: 50,
        }),
      ),
    )
    const elapsed = performance.now() - start
    console.log(`[BENCHMARK] 200 concurrent reservations: total=${elapsed.toFixed(2)}ms`)
    expect(elapsed).toBeLessThanOrEqual(2_000)
  })
})
