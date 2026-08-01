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

describe("Phase 8 — Benchmark Artifacts", () => {
  it.each(BENCHMARK_ARTIFACTS)("%s exists", (file) => {
    expect(existsSync(join(BENCHMARK_DIR, file))).toBe(true)
  })

  it("runtime-benchmark.json is valid JSON with expected metrics", () => {
    const path = join(BENCHMARK_DIR, "runtime-benchmark.json")
    expect(existsSync(path)).toBe(true)
    const raw = readFileSync(path, "utf-8")
    const parsed = JSON.parse(raw) as {
      baselineSha: string
      metrics: Record<string, { meanMs: number; medianMs: number }>
    }
    expect(parsed.baselineSha).toBe("5809fcf1230ff349ff0d7f5b53ed75403f44573b")
    expect(parsed.metrics).toBeDefined()
    for (const metric of [
      "runtimeInit",
      "commitTransition",
      "loadRunAfterRestart",
      "completePath",
      "cancellationPhase",
    ]) {
      expect(parsed.metrics[metric]).toBeDefined()
      expect(parsed.metrics[metric].meanMs).toBeGreaterThan(0)
      expect(parsed.metrics[metric].medianMs).toBeGreaterThan(0)
    }
  })

  it("runtime-benchmark.txt contains the report table", () => {
    const path = join(BENCHMARK_DIR, "runtime-benchmark.txt")
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, "utf-8")
    expect(content).toContain("Runtime Benchmark Report")
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