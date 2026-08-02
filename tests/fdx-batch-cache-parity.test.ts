/**
 * FDX Native/JS Fallback Parity Tests (Dev 3 Task 4, Phase 7).
 *
 * Verifies the three-rung batch ladder produces interchangeable results:
 *   rung 1 — daemon `batch` method (real fdxd binary, typed protocol)
 *   rung 2 — one-shot `fdx batch-query` stdin spawn (same native executor)
 *   rung 3 — pure-TS `executeBatchFallback` (canonical JS mirror)
 *
 * Assertions:
 * - wire-identical BatchResponse JSON for read/grep/impact across all rungs
 * - deterministic-field parity for search/outline (signature is shape-only)
 * - per-op error parity (unknown / mutating / missing file / bad mode)
 * - whole-batch rejection parity (empty / duplicate / over-capacity)
 * - truncation marker + artifact byte parity (native vs TS)
 * - capabilities mirror deep-equals the daemon's capabilities.query
 * - runBatchViaDaemon ladder: daemon -> one-shot -> TS, transport metrics
 *
 * testsFor parity is asserted between one-shot and TS only: the daemon builds
 * an index snapshot lazily, while the one-shot/TS paths never auto-build, so
 * the index-less error behavior is the fallback contract.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  DaemonConnection,
  resetDaemonConnection,
  runBatchViaDaemon,
  type BatchOperation,
  type BatchResponse,
  type CapabilitiesPayload,
} from "../src/tools/fdx-daemon-client"
import {
  BatchRejectError,
  executeBatchFallback,
  tsCapabilitiesPayload,
  E_BAD_REQUEST,
  E_UNSUPPORTED,
  E_INTERNAL,
  E_CANCELLED,
  TS_MAX_BATCH_OPS,
} from "../src/tools/fdx-batch-fallback"

const ROOT = resolve(import.meta.dirname, "..")
const DAEMON_NAME = process.platform === "win32" ? "fdxd.exe" : "fdxd"
const CLI_NAME = process.platform === "win32" ? "fdx.exe" : "fdx"

function findBinary(name: string, envVar: string): string | null {
  const candidates = [
    process.env[envVar],
    join(ROOT, "target", "debug", name),
    join(ROOT, "crates", "fdx", "target", "debug", name),
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

let DAEMON: string | null = findBinary(DAEMON_NAME, "FDX_DAEMON_BINARY_PATH")
let FDX: string | null = findBinary(CLI_NAME, "FDX_BINARY_PATH")
// The daemon transport is unix-socket only: on win32 the daemon rung cannot
// start, so the daemon-dependent tests skip and the one-shot/TS rungs carry
// the parity coverage (they run on every platform).
const HAVE_DAEMON = DAEMON !== null && process.platform !== "win32"
const HAVE_FDX = FDX !== null

/** Create an isolated project dir with the same fixtures as the parity probes. */
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fdx-parity-test-"))
  const src = join(dir, "src")
  mkdirSync(src, { recursive: true })
  writeFileSync(
    join(src, "greeter.ts"),
    "export function greet(name: string): string {\n  return `hello ${name}`\n}\n",
  )
  writeFileSync(join(src, "note.txt"), "// nothing here\n")
  return dir
}

/** Large fixture (900 lines × 100 chars) for truncation parity. */
function writeBigFile(dir: string): string {
  const line = `${"x".repeat(100)}\n`
  const path = join(dir, "big.txt")
  writeFileSync(path, line.repeat(900))
  return path
}

/** Rung 2: one-shot `fdx batch-query` stdin spawn (mirrors runFdxWithStdin). */
function oneShotBatch(
  binary: string,
  projectDir: string,
  operations: BatchOperation[],
  failFast = false,
): BatchResponse {
  const res = spawnSync(
    binary,
    ["batch-query", "--cwd", projectDir, ...(failFast ? ["--fail-fast"] : [])],
    { encoding: "utf-8", input: JSON.stringify(operations), maxBuffer: 50 * 1024 * 1024 },
  )
  if (res.status !== 0) {
    throw new Error((res.stderr || "").trim() || `batch-query exited ${res.status}`)
  }
  return JSON.parse(res.stdout) as BatchResponse
}

/** Simple success-path ops shared by the ladder tests. */
function simpleOps(): BatchOperation[] {
  return [
    { id: "r1", op: "read", params: { file: "src/greeter.ts", mode: "raw", limit: 5 } },
    { id: "g1", op: "grep", params: { pattern: "greet", paths: ["src"], maxMatches: 5 } },
    { id: "i1", op: "impact", params: { targets: ["src/greeter.ts"], direction: "both", depth: 1 } },
  ]
}

let conn: DaemonConnection
let projectDir: string
let savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  savedEnv = {
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    FDX_BINARY_PATH: process.env.FDX_BINARY_PATH,
    FDX_DAEMON_BINARY_PATH: process.env.FDX_DAEMON_BINARY_PATH,
  }
  // Export the CLI path so runBatchViaDaemon's one-shot rung resolves the
  // native binary via FDX_BINARY_PATH (fdx is not on PATH in test envs).
  // Done before the win32 early-return: the one-shot/TS rungs run everywhere.
  if (FDX) process.env.FDX_BINARY_PATH = FDX
  if (process.platform === "win32") {
    console.warn("fdxd --socket mode is unix-only — socket tests skipped on win32")
    return
  }
  if (!DAEMON) {
    console.warn("fdxd binary not found — attempting build")
    try {
      const { execSync } = await import("node:child_process")
      execSync(
        `cargo build --manifest-path ${join(ROOT, "crates/fdx/Cargo.toml")} --bin fdxd --bin fdx`,
        { cwd: ROOT, stdio: "pipe" },
      )
      DAEMON = findBinary(DAEMON_NAME, "FDX_DAEMON_BINARY_PATH")
      FDX = findBinary(CLI_NAME, "FDX_BINARY_PATH")
    } catch {
      console.warn("native build failed — skipping real-binary parity tests")
      DAEMON = null
      FDX = null
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
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function asBatch(resp: { ok: boolean; result?: unknown }): BatchResponse {
  expect(resp.ok).toBe(true)
  return resp.result as BatchResponse
}

/** Force the daemon rung to fail: socket/lock live under a nonexistent dir. */
function withDaemonBlocked<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.XDG_RUNTIME_DIR
  process.env.XDG_RUNTIME_DIR = join(tmpdir(), `fdx-no-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return fn().finally(() => {
    if (prev === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = prev
  })
}

describe("FDX native/JS fallback parity", () => {
  it("capabilities mirror deep-equals the daemon capabilities.query payload", async () => {
    if (!HAVE_DAEMON) return
    const resp = await conn.capabilities()
    expect(resp.ok).toBe(true)
    const payload = resp.result as CapabilitiesPayload
    expect(payload).toEqual(tsCapabilitiesPayload())
    expect(TS_MAX_BATCH_OPS).toBe(64)
  })

  it("read/grep/impact produce wire-identical BatchResponse across all three rungs", async () => {
    if (!HAVE_DAEMON) return
    const ops = simpleOps()
    const daemon = asBatch(await conn.batch(ops, projectDir))
    const ts = executeBatchFallback(ops, projectDir)
    expect(ts).toEqual(daemon)
    if (HAVE_FDX) {
      const oneShot = oneShotBatch(FDX!, projectDir, ops)
      expect(oneShot).toEqual(daemon)
    }
    // Envelope invariants shared by every rung.
    for (const r of daemon.responses) expect(r.ok).toBe(true)
    expect(daemon.version).toBe(1)
    expect(daemon.failedFast).toBe(false)
    expect(daemon.staleSnapshot).toBe(false)
  })

  it("search/outline parity on deterministic fields across daemon and TS", async () => {
    if (!HAVE_DAEMON) return
    const ops: BatchOperation[] = [
      { id: "s1", op: "search", params: { pattern: "greet", maxMatches: 10 } },
      { id: "o1", op: "outline", params: { paths: ["src/greeter.ts"] } },
    ]
    const daemon = asBatch(await conn.batch(ops, projectDir))
    const ts = executeBatchFallback(ops, projectDir)

    const dSearch = daemon.responses[0].result as {
      total_matches: number
      matches: Array<{ file: string; symbol: Record<string, unknown> }>
    }
    const tSearch = ts.responses[0].result as typeof dSearch
    expect(tSearch.total_matches).toBe(dSearch.total_matches)
    const ds = dSearch.matches[0].symbol
    const tsym = tSearch.matches[0].symbol
    for (const k of ["kind", "name", "line_start", "line_end", "parent_scope"]) {
      expect(tsym[k]).toBe(ds[k])
    }
    // Signature is shape-parity only (native includes the node body text).
    expect(typeof ds.signature).toBe("string")
    expect(typeof tsym.signature).toBe("string")

    const dOutline = daemon.responses[1].result as {
      total_files: number
      total_lines: number
      files: Array<{ path: string; language: string; symbols: Array<Record<string, unknown>> }>
    }
    const tOutline = ts.responses[1].result as typeof dOutline
    expect(tOutline.total_files).toBe(dOutline.total_files)
    expect(tOutline.total_lines).toBe(dOutline.total_lines)
    expect(tOutline.files[0].language).toBe(dOutline.files[0].language)
    const doSym = dOutline.files[0].symbols[0]
    const tSym = tOutline.files[0].symbols[0]
    for (const k of ["kind", "name", "line_start", "line_end"]) {
      expect(tSym[k]).toBe(doSym[k])
    }
  })

  it("testsFor parity between one-shot and TS (no index — both E_INTERNAL)", async () => {
    if (!HAVE_FDX) return
    const msg = "testsFor requires an index snapshot; run index.refresh first"
    const ops: BatchOperation[] = [
      // Missing source is validated first, before the index check.
      { id: "t0", op: "testsFor", params: {} },
      { id: "t1", op: "testsFor", params: { source: "src/greeter.ts" } },
    ]
    const expected = [
      { code: E_BAD_REQUEST, message: "testsFor requires 'source'" },
      { code: E_INTERNAL, message: msg },
    ]

    const oneShot = oneShotBatch(FDX!, projectDir, ops)
    for (let i = 0; i < ops.length; i++) {
      expect(oneShot.responses[i].ok).toBe(false)
      expect(oneShot.responses[i].error).toEqual(expected[i])
    }

    const ts = executeBatchFallback(ops, projectDir)
    for (let i = 0; i < ops.length; i++) {
      expect(ts.responses[i].ok).toBe(false)
      expect(ts.responses[i].error).toEqual(expected[i])
    }
  })

  it("per-op error parity across daemon, one-shot, and TS", async () => {
    if (!HAVE_DAEMON) return
    const ops: BatchOperation[] = [
      { id: "x1", op: "delete-everything", params: {} },
      { id: "m1", op: "index.refresh", params: {} },
      { id: "nf1", op: "read", params: { file: "src/missing.ts", mode: "raw" } },
      { id: "bm1", op: "read", params: { file: "src/greeter.ts", mode: "bogus" } },
    ]
    const expected = [
      { code: E_UNSUPPORTED, message: "unknown batch operation 'delete-everything'" },
      { code: E_UNSUPPORTED, message: "operation 'index.refresh' is not read-only and cannot run in a batch" },
      { code: E_INTERNAL, message: "read failed: No such file or directory (os error 2)" },
      { code: E_BAD_REQUEST, message: "invalid read mode: Unknown read mode: bogus" },
    ]
    const daemon = asBatch(await conn.batch(ops, projectDir))
    const ts = executeBatchFallback(ops, projectDir)
    for (let i = 0; i < ops.length; i++) {
      expect(daemon.responses[i].ok).toBe(false)
      expect(daemon.responses[i].error).toEqual(expected[i])
      expect(ts.responses[i].ok).toBe(false)
      expect(ts.responses[i].error).toEqual(expected[i])
    }
    if (HAVE_FDX) {
      const oneShot = oneShotBatch(FDX!, projectDir, ops)
      for (let i = 0; i < ops.length; i++) {
        expect(oneShot.responses[i].ok).toBe(false)
        expect(oneShot.responses[i].error).toEqual(expected[i])
      }
    }
  })

  it("whole-batch rejection parity across daemon, one-shot, and TS", async () => {
    if (!HAVE_DAEMON) return
    // Empty.
    const emptyMsg = "batch.operations must not be empty"
    const empty = await conn.batch([], projectDir)
    expect(empty.ok).toBe(false)
    expect(empty.error).toEqual({ code: E_BAD_REQUEST, message: emptyMsg })
    if (HAVE_FDX) {
      expect(() => oneShotBatch(FDX!, projectDir, [])).toThrow(new RegExp(emptyMsg))
    }
    expect(() => executeBatchFallback([], projectDir)).toThrow(
      new BatchRejectError(E_BAD_REQUEST, emptyMsg),
    )

    // Duplicate ids.
    const dupMsg = "duplicate batch operation id 'dup'"
    const dupOps: BatchOperation[] = [
      { id: "dup", op: "read", params: { file: "src/greeter.ts", mode: "raw", limit: 1 } },
      { id: "dup", op: "read", params: { file: "src/greeter.ts", mode: "raw", limit: 1 } },
    ]
    const dup = await conn.batch(dupOps, projectDir)
    expect(dup.ok).toBe(false)
    expect(dup.error).toEqual({ code: E_BAD_REQUEST, message: dupMsg })
    if (HAVE_FDX) {
      expect(() => oneShotBatch(FDX!, projectDir, dupOps)).toThrow(new RegExp(dupMsg))
    }
    expect(() => executeBatchFallback(dupOps, projectDir)).toThrow(
      new BatchRejectError(E_BAD_REQUEST, dupMsg),
    )

    // Over-capacity.
    const capMsg = `batch.operations exceeds the maximum of ${TS_MAX_BATCH_OPS} operations`
    const tooMany: BatchOperation[] = Array.from({ length: 65 }, (_, i) => ({
      id: `op${i}`,
      op: "read",
      params: { file: "src/greeter.ts", mode: "raw", limit: 1 },
    }))
    const cap = await conn.batch(tooMany, projectDir)
    expect(cap.ok).toBe(false)
    expect(cap.error).toEqual({ code: E_BAD_REQUEST, message: capMsg })
    if (HAVE_FDX) {
      expect(() => oneShotBatch(FDX!, projectDir, tooMany)).toThrow(new RegExp(capMsg))
    }
    expect(() => executeBatchFallback(tooMany, projectDir)).toThrow(
      new BatchRejectError(E_BAD_REQUEST, capMsg),
    )
  })

  it("truncation marker + artifact parity between one-shot and TS", async () => {
    if (!HAVE_FDX) return
    const bigDir = freshProject()
    try {
      writeBigFile(bigDir)
      const id = `big-${Date.now().toString(36)}`
      const ops: BatchOperation[] = [{ id, op: "read", params: { file: "big.txt", mode: "raw" } }]

      const oneShot = oneShotBatch(FDX!, bigDir, ops)
      const osr = oneShot.responses[0]
      expect(osr.ok).toBe(true)
      expect(osr.truncated).toBe(true)
      const marker = osr.result as { truncated: boolean; artifactRef: string; byteCount: number; limitBytes: number }
      expect(marker.limitBytes).toBe(40 * 1024)
      expect(existsSync(marker.artifactRef)).toBe(true)
      const nativeArtifact = JSON.parse(readFileSync(marker.artifactRef, "utf-8")) as {
        lines: string[]
      }
      expect(nativeArtifact.lines.length).toBeGreaterThan(400)

      // TS fallback with an explicit artifact base.
      const tsBase = join(bigDir, "ts-artifacts")
      const ts = executeBatchFallback(ops, bigDir, { artifactBase: tsBase })
      const tsr = ts.responses[0]
      expect(tsr.ok).toBe(true)
      expect(tsr.truncated).toBe(true)
      const tMarker = tsr.result as typeof marker
      expect(tMarker.truncated).toBe(true)
      expect(tMarker.byteCount).toBe(marker.byteCount)
      expect(tMarker.limitBytes).toBe(marker.limitBytes)
      expect(existsSync(tMarker.artifactRef)).toBe(true)
      const tsArtifact = JSON.parse(readFileSync(tMarker.artifactRef, "utf-8")) as {
        lines: string[]
      }
      expect(tsArtifact.lines.length).toBe(nativeArtifact.lines.length)
    } finally {
      rmSync(bigDir, { recursive: true, force: true })
    }
  })

  it("failFast parity: cancelled ops are marked E_CANCELLED and never executed", async () => {
    const ops: BatchOperation[] = [
      { id: "ok1", op: "read", params: { file: "src/greeter.ts", mode: "raw", limit: 2 } },
      { id: "bad1", op: "read", params: { file: "src/missing.ts", mode: "raw" } },
      // Would succeed if executed — must instead be cancelled (proves it
      // never ran) with an explicit cancellation result.
      { id: "ok2", op: "read", params: { file: "src/greeter.ts", mode: "raw", limit: 2 } },
    ]
    const okFlags = [true, false, false]
    const cancelledError = { code: E_CANCELLED, message: "operation cancelled by fail-fast" }

    // Rung 3 (TS): cardinality == input cardinality, IDs preserved in order.
    const ts = executeBatchFallback(ops, projectDir, { failFast: true })
    expect(ts.failedFast).toBe(true)
    expect(ts.responses.map((r) => r.ok)).toEqual(okFlags)
    expect(ts.responses.map((r) => r.id)).toEqual(["ok1", "bad1", "ok2"])
    expect(ts.responses[2].error).toEqual(cancelledError)

    // Rung 2 (one-shot native): identical semantics via --fail-fast.
    if (HAVE_FDX) {
      const oneShot = oneShotBatch(FDX!, projectDir, ops, true)
      expect(oneShot.failedFast).toBe(true)
      expect(oneShot.responses.map((r) => r.ok)).toEqual(okFlags)
      expect(oneShot.responses.map((r) => r.id)).toEqual(["ok1", "bad1", "ok2"])
      expect(oneShot.responses[2].error).toEqual(cancelledError)
      expect(oneShot.responses[2].error).toEqual(ts.responses[2].error)
    }

    // Rung 1 (daemon): failFast round-trips through the wire protocol.
    if (HAVE_DAEMON) {
      const daemon = asBatch(await conn.batch(ops, projectDir, 10_000, true))
      expect(daemon.failedFast).toBe(true)
      expect(daemon.responses.map((r) => r.ok)).toEqual(okFlags)
      expect(daemon.responses.map((r) => r.id)).toEqual(["ok1", "bad1", "ok2"])
      expect(daemon.responses[2].error).toEqual(cancelledError)
      expect(daemon.responses[2].error).toEqual(ts.responses[2].error)
    }

    // failFast=false (default) runs every op — cardinality holds either way.
    const relaxed = executeBatchFallback(ops, projectDir)
    expect(relaxed.failedFast).toBe(false)
    expect(relaxed.responses.length).toBe(3)
    expect(relaxed.responses[2].ok).toBe(true)
  })

  it("batch paths handle spaces, Unicode, and special characters", () => {
    const dir = freshProject()
    try {
      const fileName = "file with spaces & ünïcode [x] (+).txt"
      writeFileSync(join(dir, fileName), "special path content\n")
      const ops: BatchOperation[] = [
        { id: "p1", op: "read", params: { file: fileName, mode: "raw" } },
      ]

      const ts = executeBatchFallback(ops, dir)
      expect(ts.responses[0].ok).toBe(true)
      const lines = (ts.responses[0].result as { lines: string[] }).lines
      expect(lines[0]).toBe("special path content")
      expect((ts.responses[0].result as { path: string }).path).toBe(join(dir, fileName))

      if (HAVE_FDX) {
        const oneShot = oneShotBatch(FDX!, dir, ops)
        expect(oneShot.responses[0].ok).toBe(true)
        expect((oneShot.responses[0].result as { lines: string[] }).lines[0]).toBe(
          "special path content",
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runBatchViaDaemon uses the daemon transport when available", async () => {
    if (!HAVE_DAEMON) return
    const ops = simpleOps()
    const res = await runBatchViaDaemon(projectDir, ops, { cwd: projectDir })
    expect(res.fallback).toBe("ok")
    expect(res.metrics?.transport).toBe("daemon")
    expect(res.value).toEqual(asBatch(await conn.batch(ops, projectDir)))
  })

  it("runBatchViaDaemon falls back to one-shot native when the daemon cannot start", async () => {
    if (!HAVE_FDX) return
    const ops = simpleOps()
    await withDaemonBlocked(async () => {
      const dir = freshProject()
      try {
        const res = await runBatchViaDaemon(dir, ops, { cwd: dir })
        expect(res.metrics?.transport).toBe("one-shot")
        expect(res.fallback).toBe("ok")
        expect(res.value).toEqual(oneShotBatch(FDX!, dir, ops))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  it("runBatchViaDaemon falls back to pure-TS when neither binary is available", async () => {
    const prevFdx = process.env.FDX_BINARY_PATH
    const ops = simpleOps()
    try {
      process.env.FDX_BINARY_PATH = join(tmpdir(), `fdx-nonexistent-${Date.now()}`)
      await withDaemonBlocked(async () => {
        const dir = freshProject()
        try {
          const res = await runBatchViaDaemon(dir, ops, { cwd: dir })
          expect(res.metrics?.transport).toBe("ts-fallback")
          expect(res.fallback).toBe("ok")
          expect(res.value).toEqual(executeBatchFallback(ops, dir))
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })
    } finally {
      if (prevFdx === undefined) delete process.env.FDX_BINARY_PATH
      else process.env.FDX_BINARY_PATH = prevFdx
    }
  })

  it("runBatchViaDaemon normalizes whole-batch rejection from every rung", async () => {
    if (!HAVE_DAEMON) return
    const emptyMsg = "batch.operations must not be empty"

    // Rung 1: healthy daemon reports the rejection structurally.
    const fromDaemon = await runBatchViaDaemon(projectDir, [], { cwd: projectDir })
    expect(fromDaemon.error).toEqual({ code: E_BAD_REQUEST, message: emptyMsg })
    expect(fromDaemon.fallback).toBe("ok")
    expect(fromDaemon.metrics?.transport).toBe("daemon")

    // Rung 3 (TS): pure-TS rejection normalized to the same error payload.
    const prevFdx = process.env.FDX_BINARY_PATH
    try {
      process.env.FDX_BINARY_PATH = join(tmpdir(), `fdx-nonexistent-${Date.now()}`)
      await withDaemonBlocked(async () => {
        const dir = freshProject()
        try {
          const fromTs = await runBatchViaDaemon(dir, [], { cwd: dir })
          expect(fromTs.error).toEqual({ code: E_BAD_REQUEST, message: emptyMsg })
          expect(fromTs.fallback).toBe("ok")
          expect(fromTs.metrics?.transport).toBe("ts-fallback")
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })
    } finally {
      if (prevFdx === undefined) delete process.env.FDX_BINARY_PATH
      else process.env.FDX_BINARY_PATH = prevFdx
    }

    // Rung 2 (one-shot): native stderr rejection normalized.
    if (HAVE_FDX) {
      const dupMsg = "duplicate batch operation id 'dup'"
      const dupOps: BatchOperation[] = [
        { id: "dup", op: "read", params: { file: "src/greeter.ts", mode: "raw", limit: 1 } },
        { id: "dup", op: "read", params: { file: "src/greeter.ts", mode: "raw", limit: 1 } },
      ]
      await withDaemonBlocked(async () => {
        const dir = freshProject()
        try {
          const fromOneShot = await runBatchViaDaemon(dir, dupOps, { cwd: dir })
          expect(fromOneShot.error).toEqual({ code: E_BAD_REQUEST, message: dupMsg })
          expect(fromOneShot.fallback).toBe("ok")
          expect(fromOneShot.metrics?.transport).toBe("one-shot")
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })
    }
  })
})
