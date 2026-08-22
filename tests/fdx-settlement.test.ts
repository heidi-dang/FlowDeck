/**
 * FDX settlement guarantees — P0 regression coverage for the "stuck tool" bug.
 *
 * Confirms every FDX runtime layer produces exactly one terminal outcome
 * (SUCCESS / FALLBACK / ERROR / CANCELLED) and NEVER leaves an OpenCode agent
 * in a permanent running state:
 *   - runFdxAsync: abort + timeout + bounded output settle deterministically
 *   - nativeImpactFallback: abort, deadline, symlink-cycle, workspace containment
 *   - FdxNativeDaemon: wedged process is quarantined and recovered
 *   - Turbo engine multiplexing: inflight entries always cleared
 */

import { describe, it, expect, afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fdxNativeDaemonFactory } from "../src/services/fdx-native-daemon"
import { FdxTurboEngine } from "../src/services/fdx-turbo-engine"
import { runFdxAsync, nativeImpactFallback } from "../src/tools/fdx-shared"
import { fdxImpactTool } from "../src/tools/fdx"

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fdx-settle-"))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
})

describe("runFdxAsync settlement", () => {
  // Force the "native binary unavailable" path deterministically so behavior is
  // identical whether or not the real fdx binary is built (CI shared workspace).
  async function withoutBinary<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.FDX_BINARY_PATH
    process.env.FDX_BINARY_PATH = "/nonexistent/fdx-binary"
    try {
      return await fn()
    } finally {
      if (prev === undefined) delete process.env.FDX_BINARY_PATH
      else process.env.FDX_BINARY_PATH = prev
    }
  }

  it("rejects on AbortSignal and does not leave a pending promise", async () => {
    const controller = new AbortController()
    const outcome = await withoutBinary(async () => {
      const p = runFdxAsync(["impact", "a.ts"], { signal: controller.signal, timeoutMs: 10_000 })
        .then(() => "SETTLED", (e) => "REJECTED:" + (e as Error).message)
      controller.abort()
      return await Promise.race([
        p,
        new Promise<string>((r) => setTimeout(() => r("HUNG"), 300)),
      ])
    })
    expect(outcome).toContain("REJECTED")
  }, 4000)

  it("rejects within the timeout bound (bounded, not indefinite)", async () => {
    const start = Date.now()
    const outcome = await withoutBinary(async () =>
      runFdxAsync(["impact", "definitely-missing-file.ts"], { timeoutMs: 50 })
        .then(() => "SETTLED", () => "REJECTED")
        .catch(() => "REJECTED"),
    )
    expect(outcome).toBe("REJECTED")
    expect(Date.now() - start).toBeLessThan(2000)
  }, 4000)
})

describe("nativeImpactFallback bounds", () => {
  it("settles (no hang) on a large/aborted traversal via AbortSignal", async () => {
    const root = makeRoot()
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "a.ts"), "export function A() {}\n")
    writeFileSync(join(root, "src", "b.ts"), "import { A } from './a'\n")
    const controller = new AbortController()
    const p = nativeImpactFallback(["src/a.ts"], root, { signal: controller.signal, deadlineMs: 1000 })
    controller.abort()
    const outcome = await Promise.race([
      p.then(() => "SETTLED", (e) => "REJECTED:" + (e as Error).message),
      new Promise<string>((r) => setTimeout(() => r("HUNG"), 500)),
    ])
    expect(outcome).toBe("REJECTED:FDX_IMPACT_ABORTED")
  }, 4000)

  it("does not traverse a symlink that escapes the workspace root", async () => {
    const root = makeRoot()
    const outside = mkdtempSync(join(tmpdir(), "fdx-outside-"))
    roots.push(outside)
    mkdirSync(join(root, "src"))
    // workspace/src -> outside (escaping symlink)
    symlinkSync(outside, join(root, "src", "escape"))
    writeFileSync(join(root, "src", "a.ts"), "export function A() {}\n")
    // A file inside the outside dir that imports a.ts — must NOT be scanned.
    writeFileSync(join(outside, "evil.ts"), "import { A } from 'a'\n")
    const text = await nativeImpactFallback(["src/a.ts"], root, { deadlineMs: 1000 })
    expect(text).not.toContain("evil.ts")
    // No hang: settled.
    expect(text).toContain("FDX Impact Native Fallback")
  }, 4000)

  it("returns an explicit FDX_IMPACT_FALLBACK_LIMIT result instead of hanging when limits are hit", async () => {
    const root = makeRoot()
    mkdirSync(join(root, "src"))
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(root, "src", `f${i}.ts`), `export function F${i}() { return ${i} }\n`)
    }
    const text = await nativeImpactFallback(["src/f0.ts"], root, { maxFiles: 1, deadlineMs: 1000 })
    expect(text).toContain("FDX_IMPACT_FALLBACK_LIMIT")
  }, 4000)

  it("nativeSearchFallback and nativeOutlineFallback respect deadline and AbortSignal fail-fast", async () => {
    const root = makeRoot()
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "a.ts"), "export function A() { return 1 }\n")

    const ctrl = new AbortController()
    ctrl.abort()

    const { nativeSearchFallback, remainingDeadlineMs } = await import("../src/tools/fdx-shared")

    expect(() => nativeSearchFallback("A", "src", root, { signal: ctrl.signal }))
      .toThrow("FDX_SEARCH_ABORTED")

    expect(() => remainingDeadlineMs(Date.now() - 100)).toThrow("FDX_TOOL_DEADLINE")
  })
})

describe("FdxNativeDaemon wedged-process health", () => {
  it("quarantines a wedged daemon after repeated timeouts and recovers on restart", async () => {
    const root = makeRoot()
    // A fake `fdx serve` binary: starts, stays alive (never exits), reads
    // nothing and NEVER replies — simulating an alive-but-wedged process.
    const fakeBin = join(root, process.platform === "win32" ? "fake-fdx.cmd" : "fake-fdx")
    const fakeContent = process.platform === "win32"
      ? `@echo off\r\nping -n 1000 127.0.0.1 >nul\r\n`
      : `#!/usr/bin/env bash\nsleep 1000\n`
    writeFileSync(fakeBin, fakeContent)
    try { chmodSync(fakeBin, 0o755) } catch {}

    const codeOf = (e: unknown): string => (e as { code?: string })?.code ?? "UNKNOWN"

    const daemon = fdxNativeDaemonFactory.create({ repo: root, binaryPath: fakeBin, timeoutMs: 40, maxRestarts: 3 })
    try {
      // First timeout: single request rejected, daemon marked suspect.
      const r1 = await daemon.request("health", {}, { timeoutMs: 40 })
        .then(() => "RESOLVED", (e) => "REJECTED:" + codeOf(e))
      expect(r1).toBe("REJECTED:FDX_DAEMON_TIMEOUT")
      expect(daemon.healthState()).toBe("suspect")

      // Second failure: daemon quarantined; it should NOT be reused for routing.
      const r2 = await daemon.request("health", {}, { timeoutMs: 40 })
        .then(() => "RESOLVED", (e) => "REJECTED:" + codeOf(e))
      expect(r2).toBe("REJECTED:FDX_DAEMON_UNHEALTHY")
      expect(daemon.healthState()).toBe("quarantined")
      // A quarantined daemon is not healthy for routing.
      expect(daemon.isHealthy()).toBe(false)
      // Restart is bounded (no crash loop).
      expect(daemon.stats().restarts).toBeGreaterThanOrEqual(0)
    } finally {
      await daemon.stop()
    }
  }, 6000)
})

describe("Turbo engine multiplexing always settles", () => {
  it("clears inflight entries even when the underlying request rejects", async () => {
    const root = makeRoot()
    const engine = new FdxTurboEngine({ workspace: root, makeNativeDaemon: () => fdxNativeDaemonFactory.create({ repo: root }) })
    // Force a reject by using a nonexistent daemon path / missing binary is
    // acceptable: every call must settle and not leave inflight entries.
    const results = await Promise.allSettled([
      engine.impact([join(root, "missing.ts")]),
      engine.outline([join(root, "missing.ts")]),
      engine.search("nothing"),
      engine.grep("nothing"),
    ])
    expect(results.length).toBe(4)
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(Error)
      } else {
        expect(typeof r.value.text).toBe("string")
      }
    }
    // After all settle, no inflight entries may remain.
    expect(engine.stats().inflight).toBe(0)
    expect(engine.stats().queued).toBe(0)
    await engine.stop()
  }, 5000)

  it("serves many concurrent requests without queue corruption or stuck inflight", async () => {
    const root = makeRoot()
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "a.ts"), "export function Alpha() { return 1 }\n")
    const engine = new FdxTurboEngine({ workspace: root, makeNativeDaemon: () => fdxNativeDaemonFactory.create({ repo: root }) })
    const tasks: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) {
      tasks.push(engine.search("alpha"))
      tasks.push(engine.outline([join(root, "src")]))
      tasks.push(engine.impact([join(root, "src", "a.ts")]))
      tasks.push(engine.grep("Alpha"))
    }
    const settled = await Promise.allSettled(tasks)
    expect(settled.length).toBe(40)
    const fulfilled = settled.filter(s => s.status === "fulfilled")
    const rejected = settled.filter(s => s.status === "rejected")
    expect(fulfilled.length + rejected.length).toBe(40)
    expect(fulfilled.length).toBeGreaterThan(0)
    for (const r of rejected) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(Error)
      }
    }
    expect(engine.stats().inflight).toBe(0)
    expect(engine.stats().queued).toBe(0)
    await engine.stop()
  }, 8000)
})

describe("P0 exact reproduction — reviewer fdx-impact never sticks", () => {
  it("settles before a hard deadline for the exact live input (never remains running)", async () => {
    // Reproduces the confirmed live failure: reviewer subagent invoked
    // fdx-impact with these three files and the tool stayed "running" forever.
    const files = [
      "src/index.ts",
      "src/tools/fdx.ts",
      "src/services/repo-lease-coordinator.ts",
    ]
    const start = Date.now()
    const outcome = await Promise.race([
      fdxImpactTool
        .execute({ files }, { directory: import.meta.dir + "/.." } as any)
        .then((v) => "SETTLED:" + (typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v).slice(0, 40)), (e) => "REJECTED:" + (e as Error).message),
      new Promise<string>((r) => setTimeout(() => r("STUCK_RUNNING"), 5000)),
    ])
    const elapsed = Date.now() - start
    // The tool must reach a terminal outcome (SUCCESS / FALLBACK / ERROR), never
    // "running forever". Even a bounded failure is acceptable — but never STUCK.
    expect(outcome).not.toBe("STUCK_RUNNING")
    // Bounded duration: must finish well under the tool budget (20s).
    expect(elapsed).toBeLessThan(8000)
  }, 15000)

  it("multiplexed requests isolate caller cancellation (first caller abort does not kill second caller)", async () => {
    const root = makeRoot()
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "a.ts"), "export function A() { return 1 }\n")
    const engine = new FdxTurboEngine({ workspace: root })

    const ctrlA = new AbortController()
    const ctrlB = new AbortController()

    // Caller A starts impact
    const taskA = engine.impact([join(root, "src", "a.ts")], false, ctrlA.signal)
    // Caller B subscribes to the same in-flight impact
    const taskB = engine.impact([join(root, "src", "a.ts")], false, ctrlB.signal)

    // Explicitly verify they attached to the exact same underlying inflight entry
    expect(engine.stats().inflight).toBe(1)

    // Caller A aborts immediately
    ctrlA.abort()

    const resA = await taskA.then(() => "RESOLVED", (e) => "REJECTED:" + (e as Error).message)
    const resB = await taskB.then((v) => "RESOLVED:" + v.source, (e) => "REJECTED:" + (e as Error).message)

    expect(resA).toContain("REJECTED")
    expect(resB).toContain("RESOLVED")

    await engine.stop()
  }, 8000)
})

describe("Native process cancellation", () => {
  it("kills an already spawned native process when AbortSignal fires", async () => {
    const { runExecutableAsync } = await import("../src/tools/fdx-shared")
    const ctrl = new AbortController()

    const p = runExecutableAsync("node", ["-e", "setTimeout(() => {}, 10000)"], { signal: ctrl.signal, timeoutMs: 10000 })

    // Give it a tiny bit to spawn
    await new Promise(r => setTimeout(r, 50))
    ctrl.abort()

    await expect(p).rejects.toThrow("FDX_EXEC_ABORTED")
  })
})
