/**
 * FDX Typed Read-Only Batch Protocol Tests (Dev 3 Task 4).
 *
 * Spawns the REAL fdxd binary and exercises the typed batch surface:
 * - capabilities.query returns descriptor metadata for every hosted tool
 * - typed batch dispatches operations in input order (read/grep/search/outline)
 * - unknown / mutating ops produce per-op E_UNSUPPORTED without failing others
 * - whole-batch structural violations (empty, duplicate ids) → E_BAD_REQUEST
 * - failFast=false default runs all ops; failedFast flag round-trips
 * - legacy `requests` path still works (additive contract)
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  DaemonConnection,
  resetDaemonConnection,
  type BatchOperation,
  type BatchResponse,
  type CapabilitiesPayload,
  type ToolDescriptor,
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
// The daemon transport is unix-socket only; on win32 the daemon tests skip
// (beforeAll cannot establish a socket connection there).
const HAVE_DAEMON = DAEMON !== null && process.platform !== "win32"

/** Create an isolated project dir with a small source file. */
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fdx-batch-test-"))
  const src = join(dir, "src")
  mkdirSync(src, { recursive: true })
  writeFileSync(
    join(src, "greeter.ts"),
    "export function greet(name: string): string {\n  return `hello ${name}`\n}\n",
  )
  return dir
}

let conn: DaemonConnection
let projectDir: string

beforeAll(async () => {
  if (process.platform === "win32") {
    console.warn("fdxd --socket mode is unix-only — socket tests skipped on win32")
    return
  }
  if (!HAVE_DAEMON) {
    console.warn("fdxd binary not found — attempting build")
    const { execSync } = await import("node:child_process")
    try {
      execSync(
        `cargo build --manifest-path ${join(ROOT, "crates/fdx/Cargo.toml")} --bin fdxd`,
        { cwd: ROOT, stdio: "pipe" },
      )
      DAEMON = findDaemonBinary()
    } catch {
      console.warn("fdxd build failed — skipping real-binary tests")
      DAEMON = null
    }
  }
  if (!DAEMON) return
  projectDir = freshProject()
  conn = new DaemonConnection(projectDir)
  await conn.ensureStarted()
  await conn.connect()
})

afterAll(async () => {
  if (conn) {
    await conn.killSpawned()
    await conn.close()
  }
  resetDaemonConnection()
  if (projectDir) rmSync(projectDir, { recursive: true, force: true })
})

function asBatch(resp: { ok: boolean; result?: unknown }): BatchResponse {
  expect(resp.ok).toBe(true)
  return resp.result as BatchResponse
}

describe("FDX typed batch protocol", () => {
  it("capabilities.query returns descriptor metadata for all hosted tools", async () => {
    if (!HAVE_DAEMON) return
    const resp = await conn.capabilities()
    expect(resp.ok).toBe(true)
    const payload = resp.result as CapabilitiesPayload
    expect(Array.isArray(payload.descriptors)).toBe(true)
    expect(payload.descriptors.length).toBeGreaterThan(0)

    const byName = new Map(payload.descriptors.map((d: ToolDescriptor) => [d.name, d]))
    // Read-only tools that support batching must be marked.
    expect(byName.get("read")).toBeDefined()
    expect(byName.get("read")!.readOnly).toBe(true)
    expect(byName.get("read")!.supportsBatching).toBe(true)
    expect(byName.get("grep")!.supportsBatching).toBe(true)
    // Mutating index commands must NOT be batching-capable.
    expect(byName.get("index.invalidate")!.supportsBatching).toBe(false)
    expect(byName.get("index.invalidate")!.readOnly).toBe(false)
  })

  it("typed batch dispatches read + grep + search in input order", async () => {
    if (!HAVE_DAEMON) return
    const ops: BatchOperation[] = [
      {
        id: "r1",
        op: "read",
        params: { file: "src/greeter.ts", mode: "raw", limit: 5 },
      },
      {
        id: "g1",
        op: "grep",
        params: { pattern: "greet", paths: ["src"], maxMatches: 5 },
      },
      {
        id: "s1",
        op: "search",
        params: { pattern: "greet", maxMatches: 5 },
      },
    ]
    const resp = await conn.batch(ops, projectDir)
    const batch = asBatch(resp)
    expect(batch.version).toBe(1)
    expect(batch.failedFast).toBe(false)
    expect(batch.responses.length).toBe(3)
    // Responses are in input order and all succeed.
    expect(batch.responses.map((r) => r.id)).toEqual(["r1", "g1", "s1"])
    for (const r of batch.responses) expect(r.ok).toBe(true)
    // read result has text lines
    const readResult = batch.responses[0].result as {
      lines: string[]
      path: string
    }
    expect(readResult.lines.join("\n")).toContain("greet")
    expect(readResult.path).toContain("greeter.ts")
  })

  it("unknown and mutating ops are per-op E_UNSUPPORTED, others still run", async () => {
    if (!HAVE_DAEMON) return
    const ops: BatchOperation[] = [
      { id: "ok1", op: "read", params: { file: "src/greeter.ts", mode: "raw", limit: 2 } },
      { id: "bad1", op: "delete-everything", params: {} },
      { id: "bad2", op: "index.invalidate", params: {} },
      { id: "ok2", op: "grep", params: { pattern: "hello", paths: ["src"], maxMatches: 5 } },
    ]
    const resp = await conn.batch(ops, projectDir)
    const batch = asBatch(resp)
    expect(batch.responses.length).toBe(4)
    expect(batch.responses[0].ok).toBe(true)
    expect(batch.responses[1].ok).toBe(false)
    expect((batch.responses[1].error as { code: string }).code).toBe("E_UNSUPPORTED")
    expect(batch.responses[2].ok).toBe(false)
    expect((batch.responses[2].error as { code: string }).code).toBe("E_UNSUPPORTED")
    expect(batch.responses[3].ok).toBe(true)
  })

  it("rejects whole-batch structural violations with E_BAD_REQUEST", async () => {
    if (!HAVE_DAEMON) return
    // Empty operations + empty requests → rejected.
    const empty = await conn.request("batch", { version: 1, operations: [], cwd: projectDir }, 10_000)
    expect(empty.ok).toBe(false)
    expect((empty.error as { code: string }).code).toBe("E_BAD_REQUEST")

    // Duplicate ids → rejected.
    const dup = await conn.batch(
      [
        { id: "x", op: "read", params: { file: "src/greeter.ts", mode: "raw", limit: 1 } },
        { id: "x", op: "read", params: { file: "src/greeter.ts", mode: "raw", limit: 1 } },
      ],
      projectDir,
    )
    expect(dup.ok).toBe(false)
    expect((dup.error as { code: string }).code).toBe("E_BAD_REQUEST")
  })

  it("over-capacity batch (more than 64 ops) is rejected", async () => {
    if (!HAVE_DAEMON) return
    const ops: BatchOperation[] = Array.from({ length: 65 }, (_, i) => ({
      id: `op${i}`,
      op: "read",
      params: { file: "src/greeter.ts", mode: "raw", limit: 1 },
    }))
    const resp = await conn.batch(ops, projectDir)
    expect(resp.ok).toBe(false)
    expect((resp.error as { code: string }).code).toBe("E_BAD_REQUEST")
  })

  it("legacy requests path still works (additive contract)", async () => {
    if (!HAVE_DAEMON) return
    const resp = await conn.request(
      "batch",
      {
        requests: [
          {
            v: 1,
            id: 1,
            method: "query",
            params: { command: "version", argv: [], cwd: projectDir },
          },
        ],
      },
      10_000,
    )
    expect(resp.ok).toBe(true)
    const result = resp.result as { responses: Array<{ id: number; ok: boolean }> }
    expect(result.responses.length).toBe(1)
    expect(result.responses[0].ok).toBe(true)
  })
})
