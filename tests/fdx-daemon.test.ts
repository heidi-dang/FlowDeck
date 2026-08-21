import { describe, expect, it } from "bun:test"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FdxDaemon, fdxDaemonRequest } from "../src/services/fdx-daemon"

function wedgedDaemon(socketPath: string): Promise<unknown> {
  return new Promise((res) => {
    const server = createServer((socket) => { socket.on("data", () => { /* never reply */ }) })
    server.listen(socketPath, () => res(server))
  })
}
describe("optional FDX daemon", () => { it("serves structured bounded cache requests and isolates workspaces", async () => { const root = mkdtempSync(join(tmpdir(), "fdx-daemon-")); const socket = join(root, "fdx.sock"); const a = join(root, "a"); const b = join(root, "b"); require("node:fs").mkdirSync(a); require("node:fs").mkdirSync(b); const daemon = new FdxDaemon({ socketPath: socket, workspaceRoot: root }); try { await daemon.start(); expect((await fdxDaemonRequest<unknown>(socket, { method: "put", workspace: a, key: "outline", value: { a: 1 } }, () => null)).source).toBe("daemon"); expect((await fdxDaemonRequest<unknown>(socket, { method: "get", workspace: a, key: "outline" }, () => null)).value).toEqual({ a: 1 }); expect((await fdxDaemonRequest<unknown>(socket, { method: "get", workspace: b, key: "outline" }, () => "fallback")).value).toBeUndefined(); expect((await fdxDaemonRequest<unknown>(socket, { method: "get", workspace: a, key: "outline" }, () => "fallback")).source).toBe("daemon") } finally { await daemon.stop(); rmSync(root, { recursive: true, force: true }) } }); it("falls back when daemon is unavailable", async () => { expect(await fdxDaemonRequest("/tmp/no-flowdeck-fdx.sock", { method: "health", workspace: "/tmp" }, () => "safe", 50)).toEqual({ value: "safe", source: "fallback" }) }) })

describe("optional FDX daemon hardening", () => {
  it("fails closed for malformed methods, traversal, and oversized values", async () => {
    const root = mkdtempSync(join(tmpdir(), "fdx-daemon-hardening-"))
    const socket = join(root, "fdx.sock")
    const workspace = join(root, "workspace")
    require("node:fs").mkdirSync(workspace)
    const daemon = new FdxDaemon({ socketPath: socket, workspaceRoot: root, maxValueBytes: 32 })
    try {
      await daemon.start()
      expect(await fdxDaemonRequest(socket, { method: "not-allowed" as never, workspace }, () => "safe")).toEqual({ value: "safe", source: "fallback" })
      expect(await fdxDaemonRequest(socket, { method: "health", workspace: join(root, "..") }, () => "safe")).toEqual({ value: "safe", source: "fallback" })
      expect(await fdxDaemonRequest(socket, { method: "put", workspace, key: "large", value: "x".repeat(100) }, () => "safe")).toEqual({ value: "safe", source: "fallback" })
    } finally { await daemon.stop(); rmSync(root, { recursive: true, force: true }) }
  })
})

describe("fdxDaemonRequest settlement guarantees (P0 regression)", () => {
  it("REJECTS when the daemon hangs and the fallback throws (was permanent pending)", async () => {
    const root = mkdtempSync(join(tmpdir(), "fdx-settle-throw-"))
    const socket = join(root, "fdx.sock")
    const server = await wedgedDaemon(socket) as { close: () => void }
    try {
      const p = fdxDaemonRequest<unknown>(socket, { method: "health", workspace: root }, () => { throw new Error("fallback boom") }, 30)
      const outcome = await Promise.race([
        p.then(() => "SETTLED", (e) => "REJECTED:" + (e as Error).message),
        new Promise<string>((r) => setTimeout(() => r("HUNG"), 500)),
      ])
      expect(outcome).toBe("REJECTED:fallback boom")
    } finally {
      try { server.close() } catch {}
      rmSync(root, { recursive: true, force: true })
    }
  }, 4000)

  it("settles with fallback value when the daemon hangs and the fallback succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "fdx-settle-ok-"))
    const socket = join(root, "fdx.sock")
    const server = await wedgedDaemon(socket) as { close: () => void }
    try {
      const result = await fdxDaemonRequest<unknown>(socket, { method: "health", workspace: root }, () => "safe", 30)
      expect(result).toEqual({ value: "safe", source: "fallback" })
    } finally {
      try { server.close() } catch {}
      rmSync(root, { recursive: true, force: true })
    }
  }, 4000)

  it("settles with the daemon result when the daemon responds before the timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "fdx-settle-daemon-"))
    const socket = join(root, "fdx.sock")
    const server = await new Promise((res) => {
      const s = createServer((conn) => {
        conn.on("data", (buf) => {
          const req = JSON.parse(buf.toString().trim())
          conn.write(`${JSON.stringify({ id: req.id, ok: true, value: "daemon-ok" })}\n`)
        })
      })
      s.listen(socket, () => res(s))
    }) as { close: () => void }
    try {
      const result = await fdxDaemonRequest<unknown>(socket, { method: "health", workspace: root }, () => "safe", 200)
      expect(result).toEqual({ value: "daemon-ok", source: "daemon" })
    } finally {
      try { server.close() } catch {}
      rmSync(root, { recursive: true, force: true })
    }
  }, 4000)

  it("settles when the caller aborts via AbortSignal", async () => {
    const root = mkdtempSync(join(tmpdir(), "fdx-settle-abort-"))
    const socket = join(root, "fdx.sock")
    const server = await wedgedDaemon(socket) as { close: () => void }
    const controller = new AbortController()
    try {
      const p = fdxDaemonRequest<unknown>(socket, { method: "health", workspace: root }, () => "safe", 500, controller.signal)
      controller.abort()
      const outcome = await Promise.race([
        p.then(() => "SETTLED", (e) => "REJECTED:" + (e as Error).message),
        new Promise<string>((r) => setTimeout(() => r("HUNG"), 500)),
      ])
      expect(outcome).toBe("REJECTED:FDX_DAEMON_ABORTED")
    } finally {
      try { server.close() } catch {}
      rmSync(root, { recursive: true, force: true })
    }
  }, 4000)
})
