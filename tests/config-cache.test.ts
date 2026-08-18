import { describe, it, expect, beforeEach } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  getCachedConfig,
  invalidateConfigCache,
  _resetConfigCache,
} from "../src/services/config-cache"

describe("ConfigCache — Milestone F1", () => {
  let tempDir: string

  beforeEach(() => {
    _resetConfigCache()
    tempDir = mkdtempSync(join(tmpdir(), "config-cache-test-"))
  })

  it("returns DEFAULT_CONFIG when no config file exists", () => {
    const cfg = getCachedConfig(tempDir)
    expect(cfg).toBeDefined()
    expect(typeof cfg).toBe("object")
  })

  it("reads and parses flowdeck.json config", () => {
    const opencodeDir = join(tempDir, ".opencode")
    require("fs").mkdirSync(opencodeDir, { recursive: true })
    writeFileSync(
      join(opencodeDir, "flowdeck.json"),
      JSON.stringify({ governance: { mode: "strict" } })
    )
    _resetConfigCache()
    const cfg = getCachedConfig(tempDir)
    expect(cfg.governance?.mode).toBe("strict")
  })

  it("caches and returns same object on second call", () => {
    const cfg1 = getCachedConfig(tempDir)
    const cfg2 = getCachedConfig(tempDir)
    expect(cfg1).toBe(cfg2)
  })

  it("invalidation causes fresh read on next call", () => {
    const cfg1 = getCachedConfig(tempDir)
    invalidateConfigCache(tempDir)
    const cfg2 = getCachedConfig(tempDir)
    // Both are valid configs, but they should be different object instances
    expect(cfg1).not.toBe(cfg2)
  })

  it("config cache reads are fast (< 1ms p50 after warmup)", () => {
    // Warm up
    getCachedConfig(tempDir)
    const N = 1000
    const start = Date.now()
    for (let i = 0; i < N; i++) {
      getCachedConfig(tempDir)
    }
    const elapsed = Date.now() - start
    const p50 = elapsed / N
    expect(p50).toBeLessThan(1)
  })
})
