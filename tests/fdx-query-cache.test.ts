/**
 * FDX Query Cache Tests (Dev 3 Task 4, Phase 3).
 *
 * Spawns the REAL fdxd binary against a real git repository and verifies the
 * on-disk content-addressed query cache:
 * - a repeat batch is served from cache (identical result, no new entry)
 * - editing the worktree flips the dirty fingerprint → new cache key → fresh
 *   result (no stale data)
 * - `noCache: true` bypasses both cache read and write
 * - non-git directories never touch the cache (hermetic)
 *
 * The daemon inherits `FDX_INDEX_DIR` from this process, pointing at an
 * isolated per-test state dir so nothing leaks into the real user cache.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  DaemonConnection,
  resetDaemonConnection,
  type BatchOperation,
  type BatchResponse,
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

/** Run a git command in `dir`; fails the test on non-zero exit. */
function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

/** Create an isolated git repo with one committed source file. */
function freshGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fdx-cache-test-"))
  const src = join(dir, "src")
  mkdirSync(src, { recursive: true })
  writeFileSync(
    join(src, "greeter.ts"),
    "export function greet(name: string): string {\n  return `hello ${name}`\n}\n",
  )
  git(dir, ["init", "-q"])
  git(dir, ["config", "user.email", "cache-test@example.com"])
  git(dir, ["config", "user.name", "cache-test"])
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", "init"])
  return dir
}

/** Count cached result files under an FDX_INDEX_DIR state root. */
function cacheEntryCount(stateRoot: string): number {
  const ns = join(stateRoot, "fdx-index")
  if (!existsSync(ns)) return 0
  let count = 0
  for (const repo of readdirSync(ns)) {
    const repoDir = join(ns, repo)
    if (!statSync(repoDir).isDirectory()) continue
    for (const wt of readdirSync(repoDir)) {
      const qcDir = join(repoDir, wt, "query-cache")
      if (existsSync(qcDir)) count += readdirSync(qcDir).length
    }
  }
  return count
}

function negativeEntryCount(stateRoot: string): number {
  const ns = join(stateRoot, "fdx-index")
  if (!existsSync(ns)) return 0
  let count = 0
  for (const repo of readdirSync(ns)) {
    const repoDir = join(ns, repo)
    if (!statSync(repoDir).isDirectory()) continue
    for (const wt of readdirSync(repoDir)) {
      const ncDir = join(repoDir, wt, "negative-cache")
      if (existsSync(ncDir)) count += readdirSync(ncDir).length
    }
  }
  return count
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
  stateDir = mkdtempSync(join(tmpdir(), "fdx-cache-state-"))
  // Point the daemon's cache at an isolated state dir (inherited at spawn).
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

function readGreeterOps(): BatchOperation[] {
  return [
    {
      id: "r1",
      op: "read",
      params: { file: "src/greeter.ts", mode: "raw", limit: 10 },
    },
    {
      id: "g1",
      op: "grep",
      params: { pattern: "greet", paths: ["src"], maxMatches: 10 },
    },
  ]
}

describe("FDX query cache (daemon)", () => {
  it("repeat batches are served from cache with identical results", async () => {
    if (!HAVE_DAEMON) return
    const ops = readGreeterOps()

    const first = asBatch(await conn.batch(ops, projectDir))
    expect(first.responses.map((r) => r.ok)).toEqual([true, true])
    const firstRead = first.responses[0].result as { lines: string[] }
    expect(firstRead.lines.join("\n")).toContain("greet")
    const countAfterFirst = cacheEntryCount(stateDir)
    expect(countAfterFirst).toBeGreaterThan(0)

    const second = asBatch(await conn.batch(ops, projectDir))
    expect(second.responses).toEqual(first.responses)
    expect(cacheEntryCount(stateDir)).toBe(countAfterFirst)
  })

  it("worktree edits flip the key and never serve stale results", async () => {
    if (!HAVE_DAEMON) return
    const ops = readGreeterOps()
    const before = cacheEntryCount(stateDir)

    // Edit the committed file → dirty fingerprint changes → new cache key.
    writeFileSync(
      join(projectDir, "src", "greeter.ts"),
      "export function greet(name: string): string {\n  return `hello ${name}!!!`\n}\n",
    )

    const resp = asBatch(await conn.batch(ops, projectDir))
    const readResult = resp.responses[0].result as { lines: string[] }
    expect(readResult.lines.join("\n")).toContain("hello ${name}!!!")
    // Both cacheable ops (read + grep) got new keys → 2 new entries.
    expect(cacheEntryCount(stateDir)).toBe(before + 2)
  })

  it("noCache: true bypasses cache read and write", async () => {
    if (!HAVE_DAEMON) return
    const before = cacheEntryCount(stateDir)
    const ops = readGreeterOps().map((o) =>
      o.op === "read" ? { ...o, params: { ...o.params, noCache: true } } : o,
    )
    const resp = asBatch(await conn.batch(ops, projectDir))
    const readResult = resp.responses[0].result as { lines: string[] }
    expect(readResult.lines.join("\n")).toContain("greet")
    expect(cacheEntryCount(stateDir)).toBe(before)
  })

  it("index.invalidate clears both cache namespaces", async () => {
    if (!HAVE_DAEMON) return
    // Populate the positive cache (grep with matches) and negative cache
    // (definitive-empty grep) through the daemon.
    const hit = asBatch(
      await conn.batch(
        [{ id: "g1", op: "grep", params: { pattern: "greet", paths: ["src"], maxMatches: 10 } }],
        projectDir,
      ),
    )
    expect((hit.responses[0].result as { total_matches: number }).total_matches).toBeGreaterThan(0)
    const miss = asBatch(
      await conn.batch(
        [{ id: "g2", op: "grep", params: { pattern: "definitely-not-present", paths: ["src"], maxMatches: 10 } }],
        projectDir,
      ),
    )
    expect((miss.responses[0].result as { total_matches: number }).total_matches).toBe(0)
    expect(cacheEntryCount(stateDir)).toBeGreaterThan(0)
    expect(negativeEntryCount(stateDir)).toBeGreaterThan(0)

    // index.invalidate clears the query cache under the worktree.
    const inv = await conn.query("index.invalidate", [], projectDir)
    expect(inv.ok).toBe(true)
    expect(cacheEntryCount(stateDir)).toBe(0)
    expect(negativeEntryCount(stateDir)).toBe(0)

    // Results are still correct after invalidation (fresh execution).
    const after = asBatch(
      await conn.batch(
        [{ id: "g1", op: "grep", params: { pattern: "greet", paths: ["src"], maxMatches: 10 } }],
        projectDir,
      ),
    )
    expect((after.responses[0].result as { total_matches: number }).total_matches).toBeGreaterThan(0)
  })

  it("non-git project dirs never touch the cache", async () => {
    if (!HAVE_DAEMON) return
    const plainDir = mkdtempSync(join(tmpdir(), "fdx-cache-nongit-"))
    try {
      const src = join(plainDir, "src")
      mkdirSync(src, { recursive: true })
      writeFileSync(join(src, "a.txt"), "hello world\n")
      const beforeCount = cacheEntryCount(stateDir)
      const plainConn = new DaemonConnection(plainDir)
      await plainConn.ensureStarted()
      await plainConn.connect()
      const ops: BatchOperation[] = [
        { id: "r1", op: "read", params: { file: "src/a.txt", mode: "raw", limit: 5 } },
      ]
      const resp = asBatch(await plainConn.batch(ops, plainDir))
      expect((resp.responses[0].result as { lines: string[] }).lines[0]).toBe("hello world")
      // The plain project must not create any cache entries (gate is off).
      expect(cacheEntryCount(stateDir)).toBe(beforeCount)
      await plainConn.killSpawned()
      await plainConn.close()
    } finally {
      rmSync(plainDir, { recursive: true, force: true })
    }
  })
})
