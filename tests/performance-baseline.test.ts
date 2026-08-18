import { describe, it, expect } from "bun:test"
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { FdxFileCache } from "../src/services/fdx-file-cache"

/**
 * BASELINE PERFORMANCE (Requirement W)
 * Controlled, comparable tool-heavy workload on the same machine/files.
 * Baseline = one-shot disk re-read per fdx-read (pre-hardening behavior).
 * Optimized = resident hot file cache warm path.
 * Self-relative regression gate — never a Hermes benchmark.
 */
function makeWorktree() {
  const d = mkdtempSync(join(tmpdir(), "fd-bench-"))
  for (let f = 0; f < 20; f++) {
    const lines: string[] = []
    for (let i = 0; i < 1500; i++) lines.push("export const val_" + i + "_" + f + " = " + i + ";")
    writeFileSync(join(d, "mod" + f + ".ts"), lines.join("\n") + "\n", "utf8")
  }
  return d
}
function clean(d: string) { try { rmSync(d, { recursive: true, force: true }) } catch {} }

function baselineRead(f: string, limit = 600): string {
  // mirrors nativeReadFallback: full content + split + slice + join (disk each call)
  const content = readFileSync(f, "utf8")
  const lines = content.split("\n")
  return lines.slice(0, limit).join("\n")
}

describe("PERFORMANCE: FlowDeck tool fast path vs baseline (controlled)", () => {
  it("warm cached fdx-read is >= 5x faster than one-shot re-read baseline", () => {
    const d = makeWorktree()
    const files = Array.from({ length: 20 }, (_, i) => join(d, "mod" + i + ".ts"))
    const rounds = 6

    // Baseline: every logical read re-reads + re-parses from disk.
    const t0 = performance.now()
    let sz = 0
    for (let r = 0; r < rounds; r++) for (const f of files) sz += baselineRead(f).length
    const baselineMs = performance.now() - t0

    // Optimized: round 0 warms the cache; subsequent rounds are cache hits
    // (stat-only freshness check, no disk content re-read, no re-parse).
    const cache = new FdxFileCache(1024)
    for (let r = 0; r < 1; r++) for (const f of files) cache.readRange(f, 1, 600) // warm
    const t1 = performance.now()
    let sz2 = 0
    for (let r = 0; r < rounds - 1; r++) for (const f of files) { const x = cache.readRange(f, 1, 600); if (x.ok) sz2 += x.text.length }
    const optimizedMs = performance.now() - t1

    expect(sz).toBeGreaterThan(0)
    expect(sz2).toBeGreaterThan(0)
    const speedup = baselineMs / Math.max(optimizedMs, 0.001)
    expect(speedup).toBeGreaterThan(5)

    // Per-call budget sanity on this hardware: warm cache lookup < 2ms
    const perCallMs = optimizedMs / (files.length * (rounds - 1))
    expect(perCallMs).toBeLessThan(2)
    clean(d)
  })

  it("self-audit + loop-guard instrumentation stays cheap (no model call in path)", () => {
    const { RuntimeSelfAudit } = require("../src/services/runtime-self-audit")
    const { LoopDetector } = require("../src/services/loop-detector")
    const audit = new RuntimeSelfAudit()
    const ld = new LoopDetector({ enabled: true, maxRepeats: 2 })
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) {
      audit.scoreEvent({ category: "tool_execution", operation: "fdx-read", sessionID: "s", dimensionScores: { execution: 100 }, evidenceIds: [], latencyBreakdown: [] })
      const before = ld.checkBefore("fdx-read", { path: "a.ts" }, "s")
      if (before.action !== "allow") throw new Error("no")
    }
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(1000)
  })
})
