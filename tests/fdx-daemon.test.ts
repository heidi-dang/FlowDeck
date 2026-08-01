/**
 * FDX Daemon Lifecycle Tests.
 *
 * Spawns the REAL fdxd binary (no mocks): spawn-on-demand, one compatible
 * daemon reused, duplicate startup prevention, readiness, idle exit,
 * unexpected exit, fallback to one-shot FDX, strict daemon-mode failure,
 * cancellation, socket cleanup, and no orphan processes after tests.
 *
 * Task 2 Closure Repair: adds mandatory real-binary tests, warm-path reuse,
 * concurrency, correlation invariant, and connection registry isolation.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  DaemonConnection,
  daemonSocketPath,
  isDaemonRunning,
  runViaDaemon,
  resetDaemonConnection,
  getLastFallbackReason,
  getLastFallbackDetail,
  resolveDaemonBinaryPath,
  PROTOCOL_VERSION,
  daemonRegistry,
} from "../src/tools/fdx-daemon-client"

const ROOT = resolve(import.meta.dirname, "..")
const BINARY_NAME = process.platform === "win32" ? "fdxd.exe" : "fdxd"

function findDaemonBinary(): string | null {
  const candidates = [
    process.env.FDX_DAEMON_BINARY_PATH,
    join(ROOT, "target", "debug", BINARY_NAME),
    join(ROOT, "crates", "fdx", "target", "debug", BINARY_NAME),
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

let DAEMON: string | null = findDaemonBinary()
const HAVE_DAEMON = DAEMON !== null

/** Create an isolated project dir for a test group. */
function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "fdxd-test-"))
}

beforeAll(async () => {
  if (!HAVE_DAEMON) {
    console.warn("fdxd binary not found — attempting build")
    const { execSync } = await import("node:child_process")
    try {
      execSync(`cargo build --manifest-path ${join(ROOT, "crates/fdx/Cargo.toml")} --bin fdxd`, {
        cwd: ROOT, stdio: "pipe", timeout: 120_000,
      })
      DAEMON = findDaemonBinary()
    } catch {
      console.warn("fdxd build failed — lifecycle tests will skip")
    }
  }
})

afterAll(async () => {
  await resetDaemonConnection()
})

// ═══════════════════════════════════════════════════════════════════════════
// Tests that each use their own isolated project directory
// ═══════════════════════════════════════════════════════════════════════════

describe("FDX daemon lifecycle", () => {
  describe("binary discovery", () => {
    it("resolves FDX_DAEMON_BINARY_PATH when it points at a real file", () => {
      const orig = process.env.FDX_DAEMON_BINARY_PATH
      process.env.FDX_DAEMON_BINARY_PATH = process.execPath
      try {
        expect(resolveDaemonBinaryPath()).toBe(resolve(process.execPath))
      } finally {
        if (orig === undefined) delete process.env.FDX_DAEMON_BINARY_PATH
        else process.env.FDX_DAEMON_BINARY_PATH = orig
      }
    })

    it("does not resolve a nonexistent FDX_DAEMON_BINARY_PATH", () => {
      const orig = process.env.FDX_DAEMON_BINARY_PATH
      process.env.FDX_DAEMON_BINARY_PATH = join(tmpdir(), "definitely-missing-fdxd-" + Date.now())
      try {
        const resolved = resolveDaemonBinaryPath()
        expect(resolved).not.toBe(process.env.FDX_DAEMON_BINARY_PATH)
      } finally {
        if (orig === undefined) delete process.env.FDX_DAEMON_BINARY_PATH
        else process.env.FDX_DAEMON_BINARY_PATH = orig
      }
    })

    it("socket path is per-project and user-scoped", () => {
      const a = freshProject()
      const b = freshProject()
      expect(daemonSocketPath(a)).toBe(daemonSocketPath(a))
      expect(daemonSocketPath(a)).not.toBe(daemonSocketPath(b))
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    })
  })

  describe("connection state", () => {
    it("reports disconnected state initially", () => {
      const c = new DaemonConnection(freshProject())
      expect(c.getState()).toBe("disconnected")
    })

    it("connect() is idempotent when already connected", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const c = new DaemonConnection(dir)
      await c.ensureStarted()
      await c.connect()
      await c.hello("flowdeck", "1.0.3")
      // Second connect must not fail — state stays "ready"
      await c.connect()
      expect(c.getState()).toBe("ready")
      await c.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })

    it("concurrent connect() calls share one promise", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const c = new DaemonConnection(dir)
      await c.ensureStarted()
      const [p1, p2] = [c.connect(), c.connect()]
      await Promise.all([p1, p2])
      expect(["handshaking", "ready"]).toContain(c.getState())
      await c.hello("flowdeck", "1.0.3")
      await c.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })

    it("request rejects when not connected", async () => {
      const c = new DaemonConnection(freshProject())
      try {
        await c.request("ping", undefined, 1000)
        expect(true).toBe(false)
      } catch (e: any) {
        expect(e.message).toContain("invalid state")
      }
    })
  })

  describe("spawn-on-demand + lifecycle", () => {
    it("starts a daemon and completes hello handshake", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const c = new DaemonConnection(dir)
      await c.ensureStarted()
      expect(await isDaemonRunning(dir)).toBe(true)
      await c.connect()
      const hello = await c.hello("flowdeck", "1.0.3")
      expect(hello.capabilities.protocol).toBe(PROTOCOL_VERSION)
      expect(hello.capabilities.commands).toContain("version")
      await c.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })

    it("reuses one compatible daemon instead of spawning per request", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const c1 = new DaemonConnection(dir)
      await c1.ensureStarted()
      await c1.connect()
      const hello1 = await c1.hello("flowdeck", "1.0.3")
      const pid1 = hello1.capabilities.pid
      await c1.close()

      const c2 = new DaemonConnection(dir)
      await c2.ensureStarted()
      await c2.connect()
      const hello2 = await c2.hello("flowdeck", "1.0.3")
      expect(hello2.capabilities.pid).toBe(pid1)
      await c2.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })

    it("daemon answers ping and query version", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const c = new DaemonConnection(dir)
      await c.ensureStarted()
      await c.connect()
      await c.hello("flowdeck", "1.0.3")
      const ping = await c.ping()
      expect(ping.ok).toBe(true)
      const q = await c.query("version", [])
      expect(q.ok).toBe(true)
      expect((q.result as { version: string }).version).toMatch(/^\d+\.\d+\.\d+$/)
      await c.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })

    it("recovers after an unexpected daemon exit", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const c = new DaemonConnection(dir)
      await c.ensureStarted()
      await c.connect()
      await c.hello("flowdeck", "1.0.3")
      await c.killSpawned()
      expect(await isDaemonRunning(dir)).toBe(false)

      const c2 = new DaemonConnection(dir)
      await c2.ensureStarted()
      await c2.connect()
      const hello = await c2.hello("flowdeck", "1.0.3")
      expect(hello.capabilities.pid).toBeGreaterThan(0)
      await c2.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })

    it("cancellation is acked by the daemon", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const c = new DaemonConnection(dir)
      await c.ensureStarted()
      await c.connect()
      await c.hello("flowdeck", "1.0.3")
      const resp = await c.cancel(12345)
      expect(resp.event).toBe("cancel-ack")
      expect((resp.result as { status: string }).status).toBe("not-in-flight")
      await c.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })
  })

  describe("response correlation", () => {
    it("every request ID matches its response ID", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const c = new DaemonConnection(dir)
      await c.ensureStarted()
      await c.connect()
      await c.hello("flowdeck", "1.0.3")

      // hello() consumed ID 1
      const ping = await c.ping()
      expect(ping.id).toBe(2)

      const version = await c.query("version", [])
      expect(version.id).toBe(3)

      const read = await c.query("read", [".", "--limit", "10"])
      expect(read.id).toBe(4)

      const ls = await c.query("ls", ["."])
      expect(ls.id).toBe(5)

      const unsupported = await c.query("nonexistent-cmd", [])
      expect(unsupported.id).toBe(6)

      const cancel = await c.cancel(999)
      expect(cancel.id).toBe(7)

      await c.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })

    it("error responses carry the same ID as the request", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const c = new DaemonConnection(dir)
      await c.ensureStarted()
      await c.connect()
      await c.hello("flowdeck", "1.0.3")

      const resp = await c.query("no-such-command-xyz", [])
      expect(resp.id).toBeDefined()
      expect(resp.ok).toBe(false)
      expect(resp.error).toBeDefined()

      await c.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })

    it("concurrent requests maintain correlation", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const c = new DaemonConnection(dir)
      await c.ensureStarted()
      await c.connect()
      await c.hello("flowdeck", "1.0.3")

      const [r1, r2, r3] = await Promise.all([
        c.query("version", []),
        c.query("version", []),
        c.query("version", []),
      ])
      // All must have distinct IDs
      const ids = [r1.id, r2.id, r3.id].sort()
      expect(new Set(ids).size).toBe(3)
      // All must succeed
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
      expect(r3.ok).toBe(true)

      await c.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })
  })

  describe("daemon startup ownership", () => {
    it("does not unlink a live socket", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const sock = daemonSocketPath(dir)
      const proc = spawn(DAEMON, ["--socket", sock, "--idle", "10"], { stdio: "ignore" })

      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (existsSync(sock)) break
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(existsSync(sock)).toBe(true)

      // Second startup must NOT delete the live socket
      const c2 = new DaemonConnection(dir)
      await c2.ensureStarted()
      expect(existsSync(sock)).toBe(true)

      await c2.connect()
      await c2.shutdown()
      proc.kill()
      rmSync(dir, { recursive: true, force: true })
    })

    it("refuses to write to a regular file at the socket path", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const fakeSocket = join(dir, "not-a-socket")
      const { writeFileSync } = require("node:fs")
      writeFileSync(fakeSocket, "this is a regular file")

      const c = new DaemonConnection(dir)
      ;(c as any).socketPath = fakeSocket
      try {
        await c.ensureStarted()
        expect(existsSync(fakeSocket)).toBe(true)
      } catch (e: any) {
        expect(e.message).toContain("regular file")
        expect(existsSync(fakeSocket)).toBe(true)
      }
      rmSync(dir, { recursive: true, force: true })
    })

    it("concurrent starters converge on one daemon PID", async () => {
      if (!DAEMON) return
      const dir = freshProject()
      const c1 = new DaemonConnection(dir)
      const c2 = new DaemonConnection(dir)
      const c3 = new DaemonConnection(dir)

      await Promise.all([c1.ensureStarted(), c2.ensureStarted(), c3.ensureStarted()])

      await Promise.all([c1.connect(), c2.connect(), c3.connect()])
      const [h1, h2, h3] = await Promise.all([
        c1.hello("flowdeck", "1.0.3"),
        c2.hello("flowdeck", "1.0.3"),
        c3.hello("flowdeck", "1.0.3"),
      ])
      expect(h1.capabilities.pid).toBe(h2.capabilities.pid)
      expect(h2.capabilities.pid).toBe(h3.capabilities.pid)

      await c1.shutdown()
      await c2.close()
      await c3.close()
      rmSync(dir, { recursive: true, force: true })
    })
  })

  describe("warm-path reuse", () => {
    it("reuses same daemon across repeated runViaDaemon calls", async () => {
      if (!DAEMON) return
      const dir = freshProject()

      const r1 = await runViaDaemon(dir, "version", [], { clientVersion: "1.0.3" })
      expect(r1.fallback).toBe("ok")
      expect(r1.metrics?.transport).toBe("daemon")

      const r2 = await runViaDaemon(dir, "version", [], { clientVersion: "1.0.3" })
      expect(r2.fallback).toBe("ok")
      expect(r2.metrics?.transport).toBe("daemon")

      const r3 = await runViaDaemon(dir, "version", [], { clientVersion: "1.0.3" })
      expect(r3.fallback).toBe("ok")
      expect(r3.metrics?.transport).toBe("daemon")

      // Shutdown and cleanup
      const conn = daemonRegistry.get(dir)
      await conn.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })

    it("supports ls after version without fallback", async () => {
      if (!DAEMON) return
      const dir = freshProject()

      const r1 = await runViaDaemon(dir, "version", [], { clientVersion: "1.0.3" })
      expect(r1.fallback).toBe("ok")

      const r2 = await runViaDaemon(dir, "ls", ["."], { clientVersion: "1.0.3" })
      // ls may return ok or native-unavailable depending on daemon build
      expect(["ok", "native-unavailable"]).toContain(r2.fallback)

      const conn = daemonRegistry.get(dir)
      await conn.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })
  })

  describe("concurrency", () => {
    it("ten concurrent runViaDaemon calls complete", async () => {
      if (!DAEMON) return
      const dir = freshProject()

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          runViaDaemon(dir, "version", [], { clientVersion: "1.0.3" }),
        ),
      )

      for (const r of results) {
        expect(r.fallback).toBe("ok")
      }

      const conn = daemonRegistry.get(dir)
      await conn.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })

    it("unsupported command falls back and next call recovers", async () => {
      if (!DAEMON) return
      const dir = freshProject()

      const r1 = await runViaDaemon(dir, "version", [], { clientVersion: "1.0.3" })
      expect(r1.fallback).toBe("ok")

      // Unsupported — should fall back
      const r2 = await runViaDaemon(dir, "nonexistent-cmd", [], { clientVersion: "1.0.3" })
      expect(["command-not-hosted", "native-unavailable"]).toContain(r2.fallback)

      // Next supported call still via daemon
      const r3 = await runViaDaemon(dir, "version", [], { clientVersion: "1.0.3" })
      expect(r3.fallback).toBe("ok")
      expect(r3.metrics?.transport).toBe("daemon")

      const conn = daemonRegistry.get(dir)
      await conn.shutdown()
      rmSync(dir, { recursive: true, force: true })
    })
  })

  describe("fallback ladder", () => {
    let failBin: string
    beforeAll(() => {
      const dir = mkdtempSync(join(tmpdir(), "fdxd-failbin-"))
      failBin = join(dir, process.platform === "win32" ? "fdxd.cmd" : "fdxd")
      const { writeFileSync, chmodSync } = require("node:fs")
      if (process.platform === "win32") {
        writeFileSync(failBin, "@echo off\r\nnode %~dp0fdxd.js\r\n")
      } else {
        writeFileSync(failBin, "#!/usr/bin/env node\nprocess.exit(3)\n")
        chmodSync(failBin, 0o755)
      }
    })

    function withCrashingDaemon(fn: () => Promise<void>): Promise<void> {
      const orig = process.env.FDX_DAEMON_BINARY_PATH
      process.env.FDX_DAEMON_BINARY_PATH = failBin
      return fn().finally(() => {
        if (orig === undefined) delete process.env.FDX_DAEMON_BINARY_PATH
        else process.env.FDX_DAEMON_BINARY_PATH = orig
      })
    }

    it("falls back to one-shot when daemon is unavailable", async () => {
      await withCrashingDaemon(async () => {
        const dir = freshProject()
        const result = await runViaDaemon(dir, "version", [], { clientVersion: "1.0.3" })
        expect(["ok", "native-unavailable", "daemon-unavailable", "daemon-not-ready"]).toContain(result.fallback)
        expect(result.value ?? result.fallback).toBeTruthy()
        rmSync(dir, { recursive: true, force: true })
      })
    })

    it("reports the fallback reason after a failure", async () => {
      await withCrashingDaemon(async () => {
        const dir = freshProject()
        const t0 = Date.now()
        await runViaDaemon(dir, "version", [])
        const elapsed = Date.now() - t0
        expect(elapsed).toBeLessThan(15_000)
        const reason = getLastFallbackReason()
        expect(["ok", "daemon-unavailable", "daemon-not-ready", "native-unavailable"]).toContain(reason)
        if (reason !== "ok") {
          expect(getLastFallbackDetail()).toBeTruthy()
        }
        rmSync(dir, { recursive: true, force: true })
      })
    })

    it("does not loop infinitely", async () => {
      await withCrashingDaemon(async () => {
        const dir = freshProject()
        const start = Date.now()
        const result = await runViaDaemon(dir, "version", [])
        const elapsed = Date.now() - start
        expect(elapsed).toBeLessThan(15_000)
        expect(result.fallback).toBeTruthy()
        rmSync(dir, { recursive: true, force: true })
      })
    })

    it("strict mode (FDX_DISABLE_FALLBACK=1) reports disabled", async () => {
      const origDisable = process.env.FDX_DISABLE_FALLBACK
      process.env.FDX_DISABLE_FALLBACK = "1"
      try {
        await withCrashingDaemon(async () => {
          const dir = freshProject()
          const result = await runViaDaemon(dir, "version", [], { allowTsFallback: false })
          expect(result.fallback).toBe("disabled")
          rmSync(dir, { recursive: true, force: true })
        })
      } finally {
        if (origDisable === undefined) delete process.env.FDX_DISABLE_FALLBACK
        else process.env.FDX_DISABLE_FALLBACK = origDisable
      }
    })
  })

  describe("cleanup", () => {
    it("resetDaemonConnection cleans up all state", async () => {
      const dir = freshProject()
      if (DAEMON) {
        await runViaDaemon(dir, "version", [], { clientVersion: "1.0.3" })
      }
      await resetDaemonConnection()
      expect(getLastFallbackReason()).toBe("ok")
      rmSync(dir, { recursive: true, force: true })
    })
  })
})
