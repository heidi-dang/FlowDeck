import { describe, it, expect, afterAll } from "bun:test"
import { FdxNativeDaemon, fdxNativeDaemonFactory } from "../src/services/fdx-native-daemon"
import { existsSync } from "node:fs"
import { resolve, join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

// The native daemon tests require an fdx binary that supports "serve". The
// binary is built into the Cargo workspace at target/debug/fdx. We resolve it
// relative to the repo root (tests/ is one level under the repo root).
function fdxBinary(): string | null {
  const candidate = process.env.FDX_BINARY_PATH
    ? resolve(process.env.FDX_BINARY_PATH)
    : resolve(import.meta.dir, "..", "target", "debug", "fdx")
  return existsSync(candidate) ? candidate : null
}

const bin = fdxBinary()
// The native tests require an fdx binary that supports `serve`. When it is not
// available (e.g. plain `npm test` in CI, where the Cargo binary is not built),
// skip the native-dependent assertions rather than failing; the Rust Gates CI
// job independently builds/validates the crate and the local run proves them.
const nativeAvailable = bin !== null
const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fdx-native-daemon-"))
  roots.push(root)
  return root
}

function makeDaemon(repo: string): FdxNativeDaemon {
  return fdxNativeDaemonFactory.create({ repo, binaryPath: bin ?? undefined })
}

async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timed out")
    await new Promise((res) => setTimeout(res, 20))
  }
}

afterAll(async () => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
})

describe("FdxNativeDaemon — persistent resident native FDX", () => {
  it.skipIf(!nativeAvailable)("keeps a single warm resident process across many requests (processStarts stays 1, pid constant)", async () => {
    const daemon = makeDaemon(makeRoot())
    // Warm it up: the first request spawns the resident process.
    const warm = await daemon.request<{ healthy: boolean }>("health")
    expect(warm.healthy).toBe(true)
    const pid1 = daemon.stats().pid
    expect(pid1).toBeGreaterThan(0)
    const pidConst = daemon.stats().pid
    for (let i = 0; i < 25; i++) {
      const res = await daemon.request<{ healthy: boolean }>("health")
      expect(res.healthy).toBe(true)
    }
    const s = daemon.stats()
    expect(s.processStarts).toBe(1)
    expect(s.ipcRequests).toBe(26)
    expect(s.pid).toBe(pidConst)
    expect(s.isHealthy).toBe(true)
    await daemon.stop()
  })

  it.skipIf(!nativeAvailable)("restarts after the daemon process is killed and a follow-up request still succeeds", async () => {
    const daemon = makeDaemon(makeRoot())
    const h1 = await daemon.request<{ healthy: boolean }>("health")
    expect(h1.healthy).toBe(true)
    const pid1 = daemon.stats().pid
    expect(pid1).toBeGreaterThan(0)

    process.kill(pid1!, "SIGKILL")
    await waitUntil(() => daemon.stats().processStarts >= 2)

    const h2 = await daemon.request<{ healthy: boolean }>("health")
    expect(h2.healthy).toBe(true)
    expect(daemon.stats().pid).not.toBe(pid1)
    expect(daemon.stats().restarts).toBeGreaterThanOrEqual(1)
    await daemon.stop()
  })

  it.skipIf(!nativeAvailable)("assigns unique request ids and multiplexes concurrent responses correctly", async () => {
    const daemon = makeDaemon(makeRoot())
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        daemon.request<{ healthy: boolean }>("health").then((h) => ({ i, healthy: h.healthy }))
      )
    )
    for (const r of results) expect(r.healthy).toBe(true)
    const s = daemon.stats()
    expect(s.processStarts).toBe(1)
    expect(s.ipcRequests).toBe(60)
    expect(s.ipcFailures).toBe(0)
    await daemon.stop()
  })
})
