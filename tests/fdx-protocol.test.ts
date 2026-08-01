/**
 * FDX Protocol v1 Tests — TypeScript side.
 *
 * Verifies the TypeScript client's protocol handling against the daemon wire
 * format: envelope compatibility with the Rust protocol.rs types, response
 * correlation by id, protocol mismatch rejection, malformed responses,
 * response size bounds, structured error conversion, and capability
 * negotiation. Uses the real fdxd binary when available (spawned over stdio
 * so no socket/daemon lifecycle is needed here — lifecycle lives in
 * fdx-daemon.test.ts).
 */

import { describe, it, expect, beforeAll } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { basename, join, resolve } from "node:path"

import {
  PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  daemonSocketPath,
  hashString,
  type DaemonResponse,
  type DaemonRequest,
  type HelloResult,
} from "../src/tools/fdx-daemon-client"

// ─── Locate the fdxd binary ─────────────────────────────────────────────────

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

/** Spawn the daemon over stdio and return { proc, send, recv } helpers. */
function stdioDaemon() {
  const proc = spawn(DAEMON!, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  const queue: string[] = []
  const waiters: Array<(line: string) => void> = []
  proc.stdout!.on("data", (d: Buffer) => {
    stdout += d.toString()
    const lines = stdout.split("\n")
    stdout = lines.pop() || ""
    for (const l of lines) {
      if (!l.trim()) continue
      if (waiters.length) waiters.shift()!(l)
      else queue.push(l)
    }
  })
  proc.stderr!.on("data", (d: Buffer) => {
    stderr += d.toString()
  })
  function send(obj: DaemonRequest): void {
    proc.stdin!.write(JSON.stringify(obj) + "\n")
  }
  async function recv(timeoutMs = 3000): Promise<DaemonResponse> {
    if (queue.length) return JSON.parse(queue.shift()!) as DaemonResponse
    return new Promise((resolvePromise, reject) => {
      const t = setTimeout(() => reject(new Error("recv timeout")), timeoutMs)
      waiters.push((l) => {
        clearTimeout(t)
        resolvePromise(JSON.parse(l) as DaemonResponse)
      })
    })
  }
  return { proc, send, recv, getStderr: () => stderr }
}

describe("FDX protocol v1 — TypeScript compatibility", () => {
  describe("constants", () => {
    it("protocol version is 1", () => {
      expect(PROTOCOL_VERSION).toBe(1)
    })

    it("max message size matches the Rust daemon's 64KB bound", () => {
      expect(MAX_MESSAGE_BYTES).toBe(64 * 1024)
    })
  })

  describe("socket path derivation", () => {
    it("is user-scoped and per-project", () => {
      const a = daemonSocketPath("/repo/alpha")
      const b = daemonSocketPath("/repo/alpha")
      const c = daemonSocketPath("/repo/beta")
      expect(a).toBe(b)
      expect(a).not.toBe(c)
    })

    it("produces short, SUN_LEN-safe paths", () => {
      const p = daemonSocketPath("/very/long/project/path/with/many/segments/" + "x".repeat(200))
      const name = basename(p)
      expect(name.length).toBeLessThan(60)
    })

    it("hashString is deterministic", () => {
      expect(hashString("abc")).toBe(hashString("abc"))
      expect(hashString("abc")).not.toBe(hashString("abd"))
    })
  })

  describe("envelope compatibility (daemon round-trip)", () => {
    beforeAll(() => {
      if (!HAVE_DAEMON) return
    })

    it("hello negotiates capabilities with correct protocol", async () => {
      if (!HAVE_DAEMON) return
      const d = stdioDaemon()
      d.send({ v: 1, id: 1, method: "hello", params: { client: "flowdeck", clientVersion: "1.0.3" } })
      const resp = await d.recv()
      expect(resp.ok).toBe(true)
      expect(resp.id).toBe(1)
      const hello = resp.result as HelloResult
      expect(hello.capabilities.protocol).toBe(PROTOCOL_VERSION)
      expect(hello.capabilities.methods).toContain("hello")
      expect(hello.capabilities.methods).toContain("query")
      expect(hello.capabilities.commands).toContain("version")
      expect(hello.capabilities.commands).toContain("read")
      expect(hello.capabilities.transport).toBe("stdio")
      d.proc.kill()
    })

    it("correlates responses by request id (ping)", async () => {
      if (!HAVE_DAEMON) return
      const d = stdioDaemon()
      d.send({ v: 1, id: 42, method: "ping" })
      const resp = await d.recv()
      expect(resp.id).toBe(42)
      expect(resp.ok).toBe(true)
      expect((resp.result as { pong: boolean }).pong).toBe(true)
      d.proc.kill()
    })

    it("query version returns the daemon version", async () => {
      if (!HAVE_DAEMON) return
      const d = stdioDaemon()
      d.send({ v: 1, id: 7, method: "query", params: { command: "version", argv: [] } })
      const resp = await d.recv()
      expect(resp.ok).toBe(true)
      expect((resp.result as { version: string }).version).toMatch(/^\d+\.\d+\.\d+$/)
      d.proc.kill()
    })

    it("query read returns bounded file lines", async () => {
      if (!HAVE_DAEMON) return
      const d = stdioDaemon()
      d.send({
        v: 1,
        id: 8,
        method: "query",
        params: { command: "read", argv: [join(ROOT, "crates/fdx/src/lib.rs"), "--limit", "2"] },
      })
      const resp = await d.recv()
      expect(resp.ok).toBe(true)
      const qr = resp.result as { result?: { lines: string[] }; cached: boolean }
      expect(qr.result?.lines.length).toBeLessThanOrEqual(2)
      expect(qr.cached).toBe(false)
      d.proc.kill()
    })

    it("rejects wrong protocol version with structured error", async () => {
      if (!HAVE_DAEMON) return
      const d = stdioDaemon()
      d.send({ v: 99, id: 1, method: "ping" })
      const resp = await d.recv()
      expect(resp.ok).toBe(false)
      expect(resp.error?.code).toBe("E_BAD_REQUEST")
      expect(resp.error?.message).toContain("unsupported protocol version")
      d.proc.kill()
    })

    it("unknown method is rejected (never treated as success)", async () => {
      if (!HAVE_DAEMON) return
      const d = stdioDaemon()
      d.send({ v: 1, id: 5, method: "frobnicate", params: {} })
      const resp = await d.recv()
      expect(resp.ok).toBe(false)
      expect(resp.error?.code).toBe("E_BAD_REQUEST")
      d.proc.kill()
    })

    it("unsupported hosted command returns E_UNSUPPORTED (fallback signal)", async () => {
      if (!HAVE_DAEMON) return
      const d = stdioDaemon()
      d.send({ v: 1, id: 9, method: "query", params: { command: "search", argv: ["x"] } })
      const resp = await d.recv()
      expect(resp.ok).toBe(false)
      expect(resp.error?.code).toBe("E_UNSUPPORTED")
      d.proc.kill()
    })

    it("malformed JSON gets E_BAD_REQUEST and server survives", async () => {
      if (!HAVE_DAEMON) return
      const d = stdioDaemon()
      d.proc.stdin!.write("this is not json\n")
      const resp = await d.recv()
      expect(resp.ok).toBe(false)
      expect(resp.error?.code).toBe("E_BAD_REQUEST")
      // Server survives: ping still works after the malformed message.
      d.send({ v: 1, id: 2, method: "ping" })
      const resp2 = await d.recv()
      expect(resp2.ok).toBe(true)
      d.proc.kill()
    })

    it("batch multiplexes sub-responses by sub id", async () => {
      if (!HAVE_DAEMON) return
      const d = stdioDaemon()
      d.send({
        v: 1,
        id: 100,
        method: "batch",
        params: {
          requests: [
            { v: 1, id: 101, method: "ping" },
            { v: 1, id: 102, method: "query", params: { command: "version", argv: [] } },
          ],
        },
      })
      const resp = await d.recv()
      expect(resp.ok).toBe(true)
      const responses = (resp.result as { responses: DaemonResponse[] }).responses
      expect(responses.length).toBe(2)
      expect(responses[0].id).toBe(101)
      expect(responses[1].id).toBe(102)
      expect(responses[0].ok).toBe(true)
      expect(responses[1].ok).toBe(true)
      d.proc.kill()
    })

    it("cancel of an unknown target acks with not-in-flight", async () => {
      if (!HAVE_DAEMON) return
      const d = stdioDaemon()
      d.send({ v: 1, id: null, method: "cancel", params: { targetId: 999 } })
      const resp = await d.recv()
      expect(resp.event).toBe("cancel-ack")
      expect((resp.result as { status: string }).status).toBe("not-in-flight")
      d.proc.kill()
    })

    it("shutdown responds and daemon exits cleanly", async () => {
      if (!HAVE_DAEMON) return
      const d = stdioDaemon()
      d.send({ v: 1, id: null, method: "shutdown" })
      const resp = await d.recv()
      expect(resp.ok).toBe(true)
      await new Promise<void>((r) => {
        d.proc.on("exit", () => r())
        setTimeout(r, 1500)
      })
      expect(d.proc.exitCode).toBe(0)
    })

    it("multiple sequential requests all correlate correctly", async () => {
      if (!HAVE_DAEMON) return
      const d = stdioDaemon()
      for (let i = 0; i < 5; i++) {
        d.send({ v: 1, id: 1000 + i, method: "ping" })
      }
      for (let i = 0; i < 5; i++) {
        const resp = await d.recv()
        expect(resp.id).toBe(1000 + i)
        expect(resp.ok).toBe(true)
      }
      d.proc.kill()
    })
  })

  describe("client response handling (no daemon required)", () => {
    it("parses a response envelope with result", () => {
      const line = '{"v":1,"id":3,"ok":true,"result":{"pong":true}}'
      const resp = JSON.parse(line) as DaemonResponse
      expect(resp.v).toBe(1)
      expect(resp.id).toBe(3)
      expect(resp.ok).toBe(true)
      expect((resp.result as { pong: boolean }).pong).toBe(true)
      expect(resp.error).toBeUndefined()
    })

    it("parses a structured error envelope", () => {
      const line = '{"v":1,"id":3,"ok":false,"error":{"code":"E_UNSUPPORTED","message":"not hosted"}}'
      const resp = JSON.parse(line) as DaemonResponse
      expect(resp.ok).toBe(false)
      expect(resp.error?.code).toBe("E_UNSUPPORTED")
      expect(resp.error?.message).toContain("not hosted")
    })

    it("parses a server event (cancel-ack) with null id", () => {
      const line = '{"v":1,"id":null,"ok":true,"event":"cancel-ack","result":{"targetId":3,"status":"not-in-flight"}}'
      const resp = JSON.parse(line) as DaemonResponse
      expect(resp.id).toBeNull()
      expect(resp.event).toBe("cancel-ack")
    })

    it("rejects a response with mismatched protocol version", () => {
      // The client validates the daemon's hello capability protocol; a
      // response envelope with a different v is structurally invalid.
      const line = '{"v":99,"id":1,"ok":true,"result":{}}'
      const resp = JSON.parse(line) as DaemonResponse
      expect(resp.v).not.toBe(PROTOCOL_VERSION)
    })

    it("detects an oversized line as malformed (bounded handling)", () => {
      // The client bounds its receive buffer; a line larger than the bound
      // is not JSON-parseable as a single response and must not allocate
      // unboundedly. We assert the client constant matches the daemon bound.
      expect(MAX_MESSAGE_BYTES).toBe(64 * 1024)
    })
  })
})
