import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

const ROOT = process.cwd()
const BENCHMARK_DIR = join(ROOT, "benchmark-results")

const BENCHMARK_ARTIFACTS = [
  "context-efficiency.json",
  "context-efficiency.txt",
  "fdx-benchmark.json",
  "fdx-benchmark.txt",
  "orchestration-benchmark.json",
  "orchestration-benchmark.txt",
  "runtime-benchmark.json",
  "runtime-benchmark.txt",
]

const RUNTIME_METRICS = [
  "runtimeInit",
  "commitTransition",
  "loadRunAfterRestart",
  "completePath",
  "cancellationPhase",
]

const FROZEN_BASELINE_SHA = "5809fcf1230ff349ff0d7f5b53ed75403f44573b"
const RUNTIME_IMPLEMENTATION_BASELINE_SHA = "e22e04b38e45405b4ae9f15115012d0dce99c241"

describe("Phase 8 — Benchmark Artifacts", () => {
  it.each(BENCHMARK_ARTIFACTS)("%s exists", (file) => {
    expect(existsSync(join(BENCHMARK_DIR, file))).toBe(true)
  })

  it("runtime-benchmark.json is fail-closed baseline-vs-candidate evidence", () => {
    const path = join(BENCHMARK_DIR, "runtime-benchmark.json")
    expect(existsSync(path)).toBe(true)
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mode: string
      candidateSha: string
      baselineSha: string
      frozenBaselineSha: string
      runtimeImplementationBaselineSha: string
      sampleProfile: string
      metrics: Record<string, { meanMs: number; medianMs: number }>
      baselineMetrics: Record<string, { meanMs: number; medianMs: number }>
      comparison: { regressions: unknown[]; passed: boolean } | null
    }

    // Fail-closed contract: never candidate-only, comparison always present.
    expect(parsed.mode).toBe("baseline-vs-candidate")
    expect(parsed.comparison).not.toBeNull()
    expect(parsed.comparison?.passed).toBe(true)
    expect(parsed.comparison?.regressions).toEqual([])

    // Committed evidence must be full-sample (small mode is for tests only).
    expect(parsed.sampleProfile).toBe("full")

    // Exact-SHA evidence: distinct baseline constants recorded.
    expect(parsed.frozenBaselineSha).toBe(FROZEN_BASELINE_SHA)
    expect(parsed.runtimeImplementationBaselineSha).toBe(RUNTIME_IMPLEMENTATION_BASELINE_SHA)
    expect(parsed.candidateSha).toMatch(/^[0-9a-f]{40}$/)
    expect(parsed.baselineSha).toMatch(/^[0-9a-f]{40}$/)

    // Required metrics present on both candidate and baseline, positive.
    for (const metric of RUNTIME_METRICS) {
      expect(parsed.metrics[metric]).toBeDefined()
      expect(parsed.metrics[metric].meanMs).toBeGreaterThan(0)
      expect(parsed.metrics[metric].medianMs).toBeGreaterThan(0)
      expect(parsed.baselineMetrics[metric]).toBeDefined()
      expect(parsed.baselineMetrics[metric].meanMs).toBeGreaterThan(0)
      expect(parsed.baselineMetrics[metric].medianMs).toBeGreaterThan(0)
    }
  })

  it("runtime-benchmark.txt contains the report table", () => {
    const path = join(BENCHMARK_DIR, "runtime-benchmark.txt")
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, "utf-8")
    expect(content).toContain("Runtime Benchmark Report")
    expect(content).toContain("Mode: baseline-vs-candidate")
    expect(content).toContain("Candidate SHA:")
    expect(content).toContain("Baseline SHA:")
    expect(content).toContain("runtimeInit")
    expect(content).toContain("commitTransition")
    expect(content).toContain("loadRunAfterRestart")
    expect(content).toContain("completePath")
    expect(content).toContain("cancellationPhase")
  })

  it("json artifacts parse as valid JSON", () => {
    for (const file of [
      "context-efficiency.json",
      "fdx-benchmark.json",
      "orchestration-benchmark.json",
    ]) {
      const path = join(BENCHMARK_DIR, file)
      expect(existsSync(path)).toBe(true)
      expect(() => JSON.parse(readFileSync(path, "utf-8"))).not.toThrow()
    }
  })
})
