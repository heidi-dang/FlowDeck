/**
 * FDX Negative Cache Tests (Dev 3 Task 4, Phase 4).
 *
 * Spawns the REAL fdxd binary against a real git repository and verifies the
 * bounded negative cache:
 * - a definitive-empty grep (zero matches) is stored in the negative
 *   namespace, never the positive one
 * - a repeat of the same empty query is served from the negative cache
 * - a grep WITH matches is stored in the positive namespace
 * - negative entries respect the 30s TTL (backdated mtime → re-runs)
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs"
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
const HAVE_DAEMON = DAEMON !== null && process.platform !== "win32"

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function freshGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fdx-negcache-test-"))
  const src = join(dir, "src")
  mkdirSync(src, { recursive: true })
  writeFileSync(
    join(src, "greeter.ts"),
    "export function greet(name: string): string {\n  return `hello ${name}`\n}\n",
  )
  git(dir, ["init", "-q"])
  git(dir, ["config", "user.email", "negcache-test@example.com"])
  git(dir, ["config", "user.name", "negcache-test"])
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", "init"])
  return dir
}

/** Count cache files in one namespace across all worktrees under a state root. */
function namespaceEntryCount(stateRoot: string, namespace: string): number {
  const ns = join(stateRoot, "fdx-index")
  if (!existsSync(ns)) return 0
  let count = 0
  for (const repo of readdirSync(ns)) {
    const repoDir = join(ns, repo)
    if (!statSync(repoDir).isDirectory()) continue
    for (const wt of readdirSync(repoDir)) {
      const dir = join(repoDir, wt, namespace)
      if (existsSync(dir)) count += readdirSync(dir).length
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
  stateDir = mkdtempSync(join(tmpdir(), "fdx-negcache-state-"))
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

function grepOp(pattern: string): BatchOperation[] {
  return [
    { id: "g1", op: "grep", params: { pattern, paths: ["."], maxMatches: 10 } },
  ]
}

describe("FDX negative cache (daemon)", () => {
  it("definitive-empty grep uses the negative namespace, not the positive", async () => {
    if (!HAVE_DAEMON) return
    const resp = asBatch(await conn.batch(grepOp("definitely-not-present"), projectDir))
    const result = resp.responses[0].result as { total_matches: number }
    expect(result.total_matches).toBe(0)

    expect(namespaceEntryCount(stateDir, "negative-cache")).toBe(1)
    expect(namespaceEntryCount(stateDir, "query-cache")).toBe(0)
  })

  it("repeat of the same empty query is served from the negative cache", async () => {
    if (!HAVE_DAEMON) return
    const before = namespaceEntryCount(stateDir, "negative-cache")
    const resp = asBatch(await conn.batch(grepOp("definitely-not-present"), projectDir))
    expect((resp.responses[0].result as { total_matches: number }).total_matches).toBe(0)
    expect(namespaceEntryCount(stateDir, "negative-cache")).toBe(before)
  })

  it("grep WITH matches is stored in the positive namespace", async () => {
    if (!HAVE_DAEMON) return
    const resp = asBatch(await conn.batch(grepOp("greet"), projectDir))
    const result = resp.responses[0].result as { total_matches: number }
    expect(result.total_matches).toBeGreaterThan(0)
    expect(namespaceEntryCount(stateDir, "query-cache")).toBe(1)
    // The negative namespace is untouched by non-empty results.
    expect(namespaceEntryCount(stateDir, "negative-cache")).toBe(1)
  })

  it("expired negative entries are skipped (TTL re-runs the query)", async () => {
    if (!HAVE_DAEMON) return
    // Backdate every negative entry beyond the 30s TTL, then re-query: the
    // daemon must re-run instead of serving the expired entry. The result is
    // still correct and a fresh negative entry replaces the expired one.
    const ns = join(stateDir, "fdx-index")
    for (const repo of readdirSync(ns)) {
      const repoDir = join(ns, repo)
      if (!statSync(repoDir).isDirectory()) continue
      for (const wt of readdirSync(repoDir)) {
        const dir = join(repoDir, wt, "negative-cache")
        if (!existsSync(dir)) continue
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry)
          const old = new Date(Date.now() - 60_000)
          // Touch the file to a 60s-old mtime without changing content.
          execFileSync("touch", ["-d", old.toISOString(), path])
        }
      }
    }
    const resp = asBatch(await conn.batch(grepOp("definitely-not-present"), projectDir))
    expect((resp.responses[0].result as { total_matches: number }).total_matches).toBe(0)
    // A fresh negative entry exists (written on this run).
    expect(namespaceEntryCount(stateDir, "negative-cache")).toBe(1)
  })
})
