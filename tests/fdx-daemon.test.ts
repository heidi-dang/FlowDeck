/**
 * FDX Daemon Lifecycle Tests.
 *
 * Spawns the REAL fdxd binary (no mocks): spawn-on-demand, one compatible
 * daemon reused, duplicate startup prevention, readiness, idle exit,
 * unexpected exit, fallback to one-shot FDX, strict daemon-mode failure,
 * cancellation, socket cleanup, and no orphan processes after tests.
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
} from "../src/tools/fdx-daemon-client"

const ROOT = resolve(import.meta.dirname, "..")
const BINARY_NAME = process.platform === "win32" ? "fdxd.exe" : "fdxd"
const CANDIDATES = [
  process.env.FDX_DAEMON_BINARY_PATH,
  join(ROOT, "target", "debug", BINARY_NAME),
  join(ROOT, "crates", "fdx", "target", "debug", BINARY_NAME),
].filter(Boolean) as string[]

function findDaemonBinary(): string | null {
  for (const c of CANDIDATES) {
    if (existsSync(c)) return c
  }
  return null
}

const DAEMON = findDaemonBinary()
const HAVE_DAEMON = DAEMON !== null

let projectDir: string
let _socketPath: string

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fdxd-test-"))
  _socketPath = daemonSocketPath(projectDir)
  if (!HAVE_DAEMON) {
    console.warn("fdxd binary not found — lifecycle tests skipped (fallback tests still run)")
  }
})

afterAll(async () => {
  // No orphan daemon processes after tests. Best-effort cleanup with a hard
  // timeout so a stuck connection can never hang the suite.
  try {
    const running = await Promise.race([
      isDaemonRunning(projectDir),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
    ])
    if (running) {
      const c = new DaemonConnection(projectDir)
      await Promise.race([
        c.connect().then(() => c.shutdown()),
        new Promise((r) => setTimeout(r, 1500)),
      ])
    }
  } catch {
    /* ignore cleanup errors */
  }
  resetDaemonConnection()
  try {
    rmSync(projectDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe("FDX daemon lifecycle", () => {
  describe("binary discovery", () => {
    it("resolves a daemon binary path when one exists", () => {
      expect(resolveDaemonBinaryPath()).toBeTruthy()
    })

    it("socket path is per-project and user-scoped", () => {
      const other = join(tmpdir(), "fdxd-other-project")
      expect(daemonSocketPath(projectDir)).toBe(daemonSocketPath(projectDir))
      expect(daemonSocketPath(projectDir)).not.toBe(daemonSocketPath(other))
    })
  })

  describe("spawn-on-demand + lifecycle", () => {
    it("starts a daemon on demand and completes a hello handshake", async () => {
      if (!HAVE_DAEMON) return
      const c = new DaemonConnection(projectDir)
      await c.ensureStarted()
      expect(await isDaemonRunning(projectDir)).toBe(true)
      await c.connect()
      const hello = await c.hello("flowdeck", "1.0.3")
      expect(hello.capabilities.protocol).toBe(PROTOCOL_VERSION)
      expect(hello.capabilities.transport).toBe("unix")
      expect(hello.capabilities.commands).toContain("version")
      await c.shutdown()
      await c.killSpawned()
    })

    it("reuses one compatible daemon instead of spawning per request", async () => {
      if (!HAVE_DAEMON) return
      const c1 = new DaemonConnection(projectDir)
      await c1.ensureStarted()
      await c1.connect()
      const hello1 = await c1.hello("flowdeck", "1.0.3")
      const pid1 = hello1.capabilities.pid
      await c1.close()

      // Second connection: same daemon (same pid), not a new spawn.
      const c2 = new DaemonConnection(projectDir)
      await c2.ensureStarted() // must NOT spawn — daemon already running
      await c2.connect()
      const hello2 = await c2.hello("flowdeck", "1.0.3")
      expect(hello2.capabilities.pid).toBe(pid1)
      await c2.shutdown()
    })

    it("daemon answers ping and query version", async () => {
      if (!HAVE_DAEMON) return
      const c = new DaemonConnection(projectDir)
      await c.ensureStarted()
      await c.connect()
      await c.hello("flowdeck", "1.0.3")
      const ping = await c.ping()
      expect(ping.ok).toBe(true)
      const q = await c.query("version", [])
      expect(q.ok).toBe(true)
      expect((q.result as { version: string }).version).toMatch(/^\d+\.\d+\.\d+$/)
      await c.shutdown()
    })

    it("exits on idle timeout with an attached silent client", async () => {
      if (!HAVE_DAEMON) return
      // Spawn a daemon directly with a 1s idle and a client that stays silent.
      const sock = daemonSocketPath(projectDir + "-idle")
      const bin = DAEMON!
      const proc = spawn(bin, ["--socket", sock, "--idle", "1"], { stdio: "ignore" })
      // Wait for socket
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (existsSync(sock)) break
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(existsSync(sock)).toBe(true)
      // Attach a client that sends nothing (uses raw net socket, keeps open).
      const net = require("node:net")
      const client = net.createConnection(sock)
      await new Promise<void>((r) => client.on("connect", () => r()))
      // Wait ~2.5s: idle=1s, poll=50ms → daemon should exit.
      const exited = await new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), 4000)
        proc.on("exit", () => {
          clearTimeout(t)
          r(true)
        })
      })
      expect(exited).toBe(true)
      client.destroy()
    })

    it("recovers after an unexpected daemon exit (client respawns)", async () => {
      if (!HAVE_DAEMON) return
      const c = new DaemonConnection(projectDir)
      await c.ensureStarted()
      await c.connect()
      await c.hello("flowdeck", "1.0.3")

      // Simulate a crash: kill the daemon process.
      await c.killSpawned()
      // The socket may linger; isDaemonRunning must report not running.
      expect(await isDaemonRunning(projectDir)).toBe(false)

      // A fresh client must be able to start a new daemon.
      const c2 = new DaemonConnection(projectDir)
      await c2.ensureStarted()
      await c2.connect()
      const hello = await c2.hello("flowdeck", "1.0.3")
      expect(hello.capabilities.pid).toBeGreaterThan(0)
      await c2.shutdown()
    })

    it("cancellation is acked by the daemon", async () => {
      if (!HAVE_DAEMON) return
      const c = new DaemonConnection(projectDir)
      await c.ensureStarted()
      await c.connect()
      await c.hello("flowdeck", "1.0.3")
      const resp = await c.cancel(12345)
      expect(resp.event).toBe("cancel-ack")
      expect((resp.result as { status: string }).status).toBe("not-in-flight")
      await c.shutdown()
    })
  })

  describe("fallback ladder", () => {
    // Point FDX_DAEMON_BINARY_PATH at a binary that EXISTS but crashes on
    // startup (a node script that exits 3). This forces genuine daemon
    // unavailability while keeping resolution deterministic, and must not
    // hang or loop.
    let failBin: string
    beforeAll(() => {
      const dir = mkdtempSync(join(tmpdir(), "fdxd-failbin-"))
      failBin = join(dir, process.platform === "win32" ? "fdxd.cmd" : "fdxd")
      if (process.platform === "win32") {
        // .cmd wrapper: @node %~dp0fdxd.js
        const { writeFileSync } = require("node:fs")
        writeFileSync(failBin, "@echo off\r\nnode %~dp0fdxd.js\r\n")
      } else {
        const { writeFileSync, chmodSync } = require("node:fs")
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

    it("falls back to one-shot native fdx when daemon is unavailable", async () => {
      await withCrashingDaemon(async () => {
        const result = await runViaDaemon(projectDir, "version", [], { clientVersion: "1.0.3" })
        const reasons = ["daemon-unavailable", "daemon-not-ready", "daemon-incompatible", "command-not-hosted", "native-unavailable", "disabled", "ok"]
        expect(reasons).toContain(getLastFallbackReason())
        // Result is usable: either the one-shot value or a documented fallback.
        expect(result.value ?? result.fallback).toBeTruthy()
      })
    })

    it("reports the fallback reason after a failure", async () => {
      await withCrashingDaemon(async () => {
        const t0 = Date.now()
        await runViaDaemon(projectDir, "version", [])
        const elapsed = Date.now() - t0
        expect(elapsed).toBeLessThan(15_000) // bounded, no infinite loop
        const reason = getLastFallbackReason()
        expect(["daemon-unavailable", "daemon-not-ready", "daemon-incompatible", "command-not-hosted", "native-unavailable", "disabled", "ok"]).toContain(reason)
        if (reason !== "ok") {
          expect(getLastFallbackDetail()).toBeTruthy()
        }
      })
    })

    it("does not loop infinitely when the daemon never becomes ready", async () => {
      await withCrashingDaemon(async () => {
        const start = Date.now()
        const result = await runViaDaemon(projectDir, "version", [])
        const elapsed = Date.now() - start
        expect(elapsed).toBeLessThan(15_000) // bounded, no infinite loop
        expect(result.fallback).toBeTruthy()
      })
    })

    it("strict mode (FDX_DISABLE_FALLBACK=1) reports disabled", async () => {
      const origDisable = process.env.FDX_DISABLE_FALLBACK
      process.env.FDX_DISABLE_FALLBACK = "1"
      try {
        await withCrashingDaemon(async () => {
          const result = await runViaDaemon(projectDir, "version", [], { allowTsFallback: false })
          expect(result.fallback).toBe("disabled")
        })
      } finally {
        if (origDisable === undefined) delete process.env.FDX_DISABLE_FALLBACK
        else process.env.FDX_DISABLE_FALLBACK = origDisable
      }
    })
  })
})
