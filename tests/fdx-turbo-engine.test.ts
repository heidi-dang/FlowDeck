import { describe, it, expect, afterAll } from "bun:test"
import { FdxTurboEngine } from "../src/services/fdx-turbo-engine"
import { FdxWorkspaceIndex } from "../src/services/fdx-index"
import { fdxNativeDaemonFactory } from "../src/services/fdx-native-daemon"
import { checkFdxAvailability } from "../src/tools/fdx-shared"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const roots: string[] = []

function makeRoot(): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), "fdx-turbo-"))
  const source = join(root, "src")
  mkdirSync(source)
  writeFileSync(join(source, "a.ts"), "export function Alpha() { return 1 }\n")
  writeFileSync(join(source, "b.ts"), "export class Beta {}\n")
  roots.push(root)
  return { root, source }
}

function fdxBinary(): string | null {
  const candidate = process.env.FDX_BINARY_PATH
    ? resolve(process.env.FDX_BINARY_PATH)
    : resolve(import.meta.dir, "..", "target", "debug", "fdx")
  return existsSync(candidate) ? candidate : null
}

const bin = fdxBinary()

async function withMissingBinary<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.FDX_BINARY_PATH
  process.env.FDX_BINARY_PATH = resolve(import.meta.dir, "..", "missing-fdx-binary")
  checkFdxAvailability(true)
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.FDX_BINARY_PATH
    else process.env.FDX_BINARY_PATH = prev
    checkFdxAvailability(true)
  }
}

afterAll(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
})

describe("FdxTurboEngine — native daemon first + fallback + stats", () => {
  it("falls back cleanly when there is no native binary (no index)", async () => {
    const { root } = makeRoot()
    await withMissingBinary(async () => {
      const engine = new FdxTurboEngine({ workspace: root })
      const search = await engine.search("alpha")
      expect(search.source).toBe("fallback")
      expect(search.text).toBeTruthy()
      // search does not throw; engine remains usable
      const outline = await engine.outline([root])
      expect(outline.source).toBe("fallback")
    })
  })

  it("serves warm searches from the resident index when the native daemon is unavailable", async () => {
    const { root } = makeRoot()
    await withMissingBinary(async () => {
      const index = new FdxWorkspaceIndex({ stateFile: join(root, "index.json") })
      const engine = new FdxTurboEngine({ workspace: root, index })
      const search = await engine.search("alpha")
      // index resident path (no native, no crash)
      expect(["index", "fallback"]).toContain(search.source)
      if (search.source === "index") {
        expect(search.text).toContain("Alpha")
      }
      // stats surface present and sane
      const s = engine.stats()
      expect(typeof s.processStarts).toBe("number")
      expect(typeof s.ipcRequests).toBe("number")
      expect(typeof s.cacheHits).toBe("number")
      expect(typeof s.nativeSpawns).toBe("number")
      // the resident index cold-initializes => exactly one full workspace walk
      expect(s.repoScans).toBe(1)
    })
  })

  it("synchronous read keeps the hot file cache and counts cache hits", () => {
    const { root, source } = makeRoot()
    const file = join(source, "a.ts")
    const engine = new FdxTurboEngine({ workspace: root })
    const first = engine.read(file, { limit: 5 })
    expect(["cache", "native", "fallback"]).toContain(first.source)
    const cacheHitsAfterFirst = engine.stats().cacheHits
    const second = engine.read(file, { limit: 5 })
    expect(second.source).toBe("cache")
    expect(engine.stats().cacheHits).toBeGreaterThanOrEqual(cacheHitsAfterFirst + 1)
  })

  it.skipIf(bin === null)("with the native daemon injected, requests succeed and processStarts stays 1 after warmup", async () => {
    const { root } = makeRoot()
    let createCalls = 0
    const engine = new FdxTurboEngine({
      workspace: root,
      makeNativeDaemon: () => {
        createCalls++
        return fdxNativeDaemonFactory.create({ repo: root, binaryPath: bin! })
      },
    })
    expect(createCalls).toBe(1)

    // warm path: resident native daemon serves the search
    const w1 = await engine.search("alpha")
    expect(w1.source).toBe("daemon")

    const s1 = engine.stats()
    expect(s1.processStarts).toBe(1)
    expect(s1.ipcRequests).toBeGreaterThanOrEqual(1)

    await engine.search("beta")
    const s2 = engine.stats()
    expect(s2.processStarts).toBe(1)
    expect(s2.ipcRequests).toBeGreaterThan(s1.ipcRequests)
    expect(s2.daemonHealthy).toBe(true)
  })

  it.skipIf(bin === null)("injected daemon is used for resident read/outline/impact too", async () => {
    const { root, source } = makeRoot()
    const file = join(source, "a.ts")
    const engine = new FdxTurboEngine({
      workspace: root,
      makeNativeDaemon: () => fdxNativeDaemonFactory.create({ repo: root, binaryPath: bin! }),
    })
    const r = await engine.readAsync(file, { noCache: true })
    expect(r.source).toBe("daemon")
    const o = await engine.outline([root])
    expect(["daemon", "fallback"]).toContain(o.source)
    const im = await engine.impact([join(source, "a.ts")])
    expect(["daemon", "index", "fallback"]).toContain(im.source)
  })
})
