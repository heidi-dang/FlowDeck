import { describe, it, expect } from "bun:test"
import { FdxFileCache, cachedReadText } from "../src/services/fdx-file-cache"
import { fdxFileCache } from "../src/services/fdx-file-cache"
import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync, writeFileSync, rmSync } from "fs"

function dir() { const d = mkdtempSync(join(tmpdir(), "fd-fdxcache-")); return d }
function clean(d: string) { try { rmSync(d, { recursive: true, force: true }) } catch {} }

describe("FDX HOT FILE CACHE (Requirement Q)", () => {
  it("unchanged file => immediate cache hit (second read cached)", () => {
    const d = dir()
    const p = join(d, "a.ts")
    writeFileSync(p, "line1\nline2\nline3\nline4\nline5\n", "utf8")
    const cache = new FdxFileCache()
    const first = cache.readRange(p, 1, 5)
    expect(first.ok).toBe(true)
    expect(first.cached).toBe(false)
    const second = cache.readRange(p, 1, 5)
    expect(second.ok).toBe(true)
    expect(second.cached).toBe(true)
    // content identical
    expect(first.text).toBe(second.text)
    clean(d)
  })
  it("write/edit invalidates affected entries immediately (no stale reads)", () => {
    const d = dir()
    const p = join(d, "b.ts")
    writeFileSync(p, "old\n", "utf8")
    const cache = new FdxFileCache()
    const r1 = cache.readRange(p, 1, 10)
    expect(r1.text).toContain("old")
    // simulate write
    writeFileSync(p, "new content\n", "utf8")
    cache.invalidate(p)
    const r2 = cache.readRange(p, 1, 10)
    expect(r2.cached).toBe(false)
    expect(r2.text).toContain("new content")
    // resolved path deduplication
    const r3 = cache.readRange(join(d, ".", "b.ts"), 1, 10)
    expect(r3.cached).toBe(true)
    clean(d)
  })
  it("deterministic range read with fdx-read semantics (offset/limit)", () => {
    const d = dir()
    const p = join(d, "c.ts")
    writeFileSync(p, "a\nb\nc\nd\ne\nf\ng\n", "utf8")
    fdxFileCache.invalidateAll()
    const out = cachedReadText(p, 3, 3)
    const body = out.split("\n").slice(1).join("\n")
    expect(body).toContain("c")
    expect(body).toContain("e")
    expect(body).not.toContain("f")
    expect(body).not.toContain("g")
    fdxFileCache.invalidateAll()
    clean(d)
  })
})
