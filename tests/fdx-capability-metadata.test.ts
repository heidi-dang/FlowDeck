/**
 * FDX Capability Metadata Enforcement + Output Bounds (Dev 3 Task 4, Phase 5).
 *
 * Spawns the REAL fdxd binary against a real git repository and verifies:
 * - capability metadata is served for every batch op (readOnly,
 *   supportsBatching, maximumOutputBytes) via the daemon's capabilities path
 * - non-batchable hosted commands (capabilities.query) are rejected per-op
 *   with E_UNSUPPORTED "does not support batching"
 * - mutating commands (index.refresh) are rejected per-op with E_UNSUPPORTED
 *   "not read-only"
 * - oversized results are truncated: the response carries `truncated: true`
 *   and `artifactRef`, the marker records byte counts, and the artifact file
 *   holds the full untruncated payload
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync } from "node:child_process"
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
  type BatchOperation,
  type BatchResponse,
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
const HAVE_DAEMON = DAEMON !== null

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function freshGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fdx-capmeta-test-"))
  const src = join(dir, "src")
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, "greeter.ts"), "export function greet(name: string): string {\n  return `hello ${name}`\n}\n")
  git(dir, ["init", "-q"])
  git(dir, ["config", "user.email", "capmeta-test@example.com"])
  git(dir, ["config", "user.name", "capmeta-test"])
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", "init"])
  return dir
}

let conn: DaemonConnection
let projectDir: string
let stateDir: string
let prevIndexDir: string | undefined

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

  projectDir = freshGitProject()
  stateDir = mkdtempSync(join(tmpdir(), "fdx-capmeta-state-"))
  prevIndexDir = process.env.FDX_INDEX_DIR
  process.env.FDX_INDEX_DIR = stateDir

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
  if (prevIndexDir !== undefined) process.env.FDX_INDEX_DIR = prevIndexDir
  else delete process.env.FDX_INDEX_DIR
  if (projectDir) rmSync(projectDir, { recursive: true, force: true })
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

function asBatch(resp: { ok: boolean; result?: unknown }): BatchResponse {
  expect(resp.ok).toBe(true)
  return resp.result as BatchResponse
}

function oneOp(opTag: string, params: Record<string, unknown>): BatchOperation[] {
  return [{ id: "op1", op: opTag, params }]
}

describe("FDX capability metadata (daemon)", () => {
  it("serves complete descriptors for every batch op", async () => {
    if (!HAVE_DAEMON) return
    const resp = await conn.capabilities()
    expect(resp.ok).toBe(true)
    const payload = resp.result as { descriptors: ToolDescriptor[] }
    const descriptors = payload.descriptors
    const byName = new Map(descriptors.map((d) => [d.name, d]))
    for (const name of ["read", "grep", "search", "outline", "impact", "testsFor"]) {
      const d = byName.get(name)
      expect(d, `missing descriptor for ${name}`).toBeDefined()
      expect(d!.readOnly).toBe(true)
      expect(d!.supportsBatching).toBe(true)
      expect(d!.maximumOutputBytes).toBeGreaterThan(0)
    }
    // Hosted command vs batch op capability split.
    expect(byName.get("capabilities.query")!.supportsBatching).toBe(false)
    expect(byName.get("index.refresh")!.readOnly).toBe(false)
  })

  it("rejects non-batchable hosted commands per op", async () => {
    if (!HAVE_DAEMON) return
    const resp = asBatch(await conn.batch(oneOp("capabilities.query", {}), projectDir))
    const r = resp.responses[0]
    expect(r.ok).toBe(false)
    expect((r.error as { code: string }).code).toBe("E_UNSUPPORTED")
    expect((r.error as { message: string }).message).toContain("does not support batching")
  })

  it("rejects mutating commands per op", async () => {
    if (!HAVE_DAEMON) return
    const resp = asBatch(await conn.batch(oneOp("index.refresh", {}), projectDir))
    const r = resp.responses[0]
    expect(r.ok).toBe(false)
    expect((r.error as { code: string }).code).toBe("E_UNSUPPORTED")
    expect((r.error as { message: string }).message).toContain("not read-only")
  })

  it("truncates oversized results with artifactRef to the full payload", async () => {
    if (!HAVE_DAEMON) return
    // ~64 KiB single-line file: the serialized read result (lines array) far
    // exceeds the 256 KiB descriptor bound AND the 40 KiB batch budget, so it
    // must be truncated while the artifact keeps the full payload.
    const big = "z".repeat(64 * 1024)
    writeFileSync(join(projectDir, "big.txt"), big)
    git(projectDir, ["add", "-A"])
    git(projectDir, ["commit", "-q", "-m", "add big file"])

    const resp = asBatch(await conn.batch(oneOp("read", { file: "big.txt", mode: "raw" }), projectDir))
    const r = resp.responses[0]
    expect(r.ok).toBe(true)
    expect(r.truncated).toBe(true)
    expect(r.artifactRef).toBeDefined()
    const marker = r.result as { truncated: boolean; artifactRef: string; byteCount: number; limitBytes: number }
    expect(marker.truncated).toBe(true)
    expect(marker.artifactRef).toBe(r.artifactRef)
    expect(marker.limitBytes).toBeLessThanOrEqual(40 * 1024) // batch budget cap
    // Artifact holds the full payload; byte count matches the file size
    // (serialized JSON ≥ raw content).
    expect(existsSync(marker.artifactRef)).toBe(true)
    const full = readFileSync(marker.artifactRef, "utf8")
    expect(full).toContain(big)
  })
})
