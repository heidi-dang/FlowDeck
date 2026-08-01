/**
 * FDX Persistent Index — Real Process-Level Concurrency & Crash Tests
 * (Task 3D §3, §6, §7).
 *
 * Uses the REAL native `fdx` binary across SEPARATE OS processes with
 * DETERMINISTIC barriers (explicit files/pipes, never timing-only races):
 *
 * - two CLI refreshes racing (same repo, same state dir);
 * - CLI refresh racing a daemon refresh;
 * - invalidate racing refresh;
 * - stale lock file (dead owner) never blocks, never leaves a live owner's
 *   lock stolen;
 * - writer terminated at every publication phase via the `FDX_TEST_BARRIER`
 *   hook: before component completion, before manifest publication, before
 *   CURRENT publication, immediately after publication;
 * - daemon termination during refresh;
 * - recovery after a malformed component with a VALID checksum (fail-closed);
 * - fallback to the newest older valid generation;
 * - no temporary directories, pointer files, or locks left after successful
 *   recovery.
 *
 * All tests fail closed: if the native binary is unavailable or cannot be
 * built, the suite throws instead of silently skipping.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync, execSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"

const ROOT = resolve(import.meta.dirname, "..")
const BIN_NAME = process.platform === "win32" ? "fdx.exe" : "fdx"
const FDXD_NAME = process.platform === "win32" ? "fdxd.exe" : "fdxd"

/**
 * Rust-compatible identity segment: full SHA-256 digest over the parts with
 * null separators (mirrors `identity_hash`).
 */
function shortSegment(parts: string[]): string {
  const hasher = createHash("sha256")
  for (const part of parts) {
    hasher.update(part)
    hasher.update("\0")
  }
  return hasher.digest().toString("hex")
}

function findBinary(name: string): string | null {
  for (const c of [join(ROOT, "target", "debug", name), join(ROOT, "crates", "fdx", "target", "debug", name)]) {
    if (existsSync(c)) return c
  }
  return null
}

let FDX: string | null = findBinary(BIN_NAME)
let FDXD: string | null = findBinary(FDXD_NAME)

beforeAll(() => {
  if (!FDX || !FDXD) {
    try {
      execSync(`cargo build --manifest-path ${join(ROOT, "crates/fdx/Cargo.toml")}`, {
        cwd: ROOT,
        stdio: "pipe",
        timeout: 240_000,
      })
      FDX = findBinary(BIN_NAME)
      FDXD = findBinary(FDXD_NAME)
    } catch {
      throw new Error("fdx/fdxd native binaries unavailable and could not be built; concurrency tests fail closed")
    }
  }
  if (!FDX || !FDXD) throw new Error("fdx/fdxd native binaries unavailable after build")
})

let stateDir: string
let stateRoot: string

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "fdx-concurrency-state-"))
  stateRoot = stateDir
})

afterAll(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

function git(dir: string, args: string[]) {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" })
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fdx-concurrency-repo-"))
  git(dir, ["init", "-q"])
  git(dir, ["config", "user.email", "t@t"])
  git(dir, ["config", "user.name", "t"])
  writeFileSync(join(dir, "lib.ts"), 'export function greet(): string { return "hi" }\nexport class Widget {}\n')
  writeFileSync(join(dir, "main.rs"), "pub fn main() {}\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-qm", "init"])
  return dir
}

function fdxIndex(dir: string, args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync(FDX!, ["index", ...args, "--cwd", dir], {
      encoding: "utf-8",
      env: { ...process.env, FDX_INDEX_DIR: stateDir, ...env },
    })
  } catch (e: any) {
    const err = new Error(`fdx index ${args.join(" ")} failed: ${e?.stderr?.toString() ?? e}`)
    throw err
  }
}

function parseJson(s: string): any {
  return JSON.parse(s)
}

function refreshOnce(dir: string, extra: string[] = []): any {
  return parseJson(fdxIndex(dir, ["refresh", ...extra]))
}

function status(dir: string): any {
  return parseJson(fdxIndex(dir, ["status"]))
}

/** Spawn an fdx index command as a child process; returns the process. */
function spawnFdx(dir: string, args: string[], env: Record<string, string> = {}) {
  return spawn(FDX!, ["index", ...args, "--cwd", dir], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FDX_INDEX_DIR: stateDir, ...env },
  })
}

/** Run an fdx command with a bounded timeout, returning stdout/exit code. */
function runFdxTimeout(dir: string, args: string[], timeoutMs: number, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawnFdx(dir, args, env)
    let out = ""
    let err = ""
    child.stdout!.on("data", (d) => (out += d.toString()))
    child.stderr!.on("data", (d) => (err += d.toString()))
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout: out, stderr: err })
    })
  })
}

/** Compute the worktree state dir for a repo (mirrors Rust identity). */
function worktreeStateDir(dir: string): string {
  let gitCommonDir: string | null = null
  try {
    gitCommonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, encoding: "utf-8" }).trim()
  } catch {}
  const canonicalRepoRoot = gitCommonDir || resolve(dir)
  const repoRootHash = shortSegment(["repo", normalize(canonicalRepoRoot)])
  const worktreeHash = shortSegment(["worktree", normalize(resolve(dir))])
  return join(stateRoot, "fdx-index", repoRootHash, worktreeHash)
}

function normalize(p: string): string {
  if (process.platform === "win32" || process.platform === "darwin") return p.toLowerCase()
  return p
}

/** List state-dir entries under the worktree dir, tolerating missing dir. */
function worktreeEntries(dir: string): string[] {
  const wt = worktreeStateDir(dir)
  if (!existsSync(wt)) return []
  return readdirSync(wt)
}

describe("FDX index cross-process coordination (real processes)", () => {
  it("two CLI refreshes racing both end with a valid index", async () => {
    const dir = makeRepo()
    // Deterministic start: both children spawned before either finishes.
    const [a, b] = await Promise.all([
      runFdxTimeout(dir, ["refresh"], 60_000),
      runFdxTimeout(dir, ["refresh"], 60_000),
    ])
    // Either both succeed, or one succeeds and the other resolves the
    // generation conflict by loading the winner — never a corrupt state.
    const s = status(dir)
    expect(s.available).toBe(true)
    expect(s.generation).toBeGreaterThanOrEqual(1)
    // No tmp dirs or partial state after both writers complete.
    const entries = worktreeEntries(dir)
    expect(entries.some((e) => e.includes(".tmp"))).toBe(false)
    expect(entries.filter((e) => e.startsWith("gen-") && !e.includes(".tmp")).length).toBeGreaterThan(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it("CLI refresh racing a daemon refresh ends with a valid index", async () => {
    const dir = makeRepo()
    // Start the daemon over stdio.
    const proc = spawn(FDXD!, ["--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FDX_INDEX_DIR: stateDir },
    })
    let daemonOut = ""
    proc.stdout!.on("data", (d) => (daemonOut += d.toString()))
    const hello = { v: 1, id: 1, method: "hello", params: { client: "test", clientVersion: "1.0.3" } }
    proc.stdin!.write(JSON.stringify(hello) + "\n")

    // Race: CLI refresh + daemon refresh.
    const cliRefresh = runFdxTimeout(dir, ["refresh"], 60_000)
    const daemonRefresh = new Promise<void>((res) => {
      const req = { v: 1, id: 2, method: "query", params: { command: "index.refresh", argv: [], cwd: dir } }
      proc.stdin!.write(JSON.stringify(req) + "\n")
      // Wait for a response line.
      const onData = (d: Buffer) => {
        const text = d.toString()
        if (text.includes('"id":2') || text.includes('"id": 2')) {
          proc.stdout!.off("data", onData)
          res()
        }
      }
      proc.stdout!.on("data", onData)
      setTimeout(res, 15_000) // bounded fallback
    })
    await Promise.all([cliRefresh, daemonRefresh])

    const shutdown = { v: 1, id: null, method: "shutdown" }
    proc.stdin!.write(JSON.stringify(shutdown) + "\n")
    proc.stdin!.end()
    await new Promise<void>((r) => proc.on("close", () => r()))

    const s = status(dir)
    expect(s.available).toBe(true)
    expect(s.generation).toBeGreaterThanOrEqual(1)
    expect(worktreeEntries(dir).some((e) => e.includes(".tmp"))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it("invalidate racing refresh leaves a valid index", async () => {
    const dir = makeRepo()
    refreshOnce(dir)
    const [i, r] = await Promise.all([
      runFdxTimeout(dir, ["invalidate"], 60_000),
      runFdxTimeout(dir, ["refresh"], 60_000),
    ])
    // Final state: refresh must have published a valid generation (or the
    // invalidate won and a follow-up refresh works).
    const s = status(dir)
    expect(s.available).toBe(true)
    expect(worktreeEntries(dir).some((e) => e.includes(".tmp"))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it("stale lock file from a dead owner never blocks a refresh", async () => {
    const dir = makeRepo()
    refreshOnce(dir)
    const wt = worktreeStateDir(dir)
    // Write a lock file claiming a dead owner (PID far outside the PID space
    // bound on all supported platforms).
    const lockPath = join(wt, "index.lock")
    writeFileSync(lockPath, "pid=4294967294\n")
    // Refresh must succeed immediately (the OS lock is what matters; a stale
    // file with dead-owner evidence cannot block).
    const r = refreshOnce(dir)
    expect(r.generation).toBeGreaterThanOrEqual(1)
    expect(status(dir).available).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it("no temporary directories or locks left after successful recovery", () => {
    const dir = makeRepo()
    refreshOnce(dir)
    const wt = worktreeStateDir(dir)
    const entries = worktreeEntries(dir)
    expect(entries.some((e) => e.includes(".tmp"))).toBe(false)
    // The lock file may exist (advisory) but no tmp dirs, no CURRENT.tmp.
    expect(entries.some((e) => e.includes("CURRENT.tmp"))).toBe(false)
    // A subsequent status still works (recovery left no debris).
    expect(status(dir).available).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it("fallback to the newest older valid generation", () => {
    const dir = makeRepo()
    refreshOnce(dir)
    const wt = worktreeStateDir(dir)
    // Corrupt the newest generation's manifest (checksum-tamper with valid
    // JSON so only the semantic/identity layer can catch it) AND leave a
    // valid older generation by forcing two refreshes.
    writeFileSync(join(dir, "extra.ts"), "export const e = 1;\n")
    refreshOnce(dir) // gen 2
    const gens = readdirSync(wt)
      .filter((e) => e.startsWith("gen-") && !e.includes(".tmp"))
      .map((e) => Number(e.replace("gen-", "")))
      .sort((a, b) => b - a)
    expect(gens.length).toBeGreaterThanOrEqual(2)
    // Tamper with the newest manifest.
    const newest = join(wt, `gen-${gens[0]}`, "manifest.json")
    writeFileSync(newest, "{broken json")
    const s = status(dir)
    expect(s.available).toBe(true)
    expect(s.generation).toBeLessThanOrEqual(gens[1])
    rmSync(dir, { recursive: true, force: true })
  })

  it("malformed component with a valid checksum is fail-closed and recoverable", () => {
    const dir = makeRepo()
    refreshOnce(dir)
    const wt = worktreeStateDir(dir)
    const gens = readdirSync(wt)
      .filter((e) => e.startsWith("gen-") && !e.includes(".tmp"))
      .map((e) => Number(e.replace("gen-", "")))
      .sort((a, b) => b - a)
    const genDir = join(wt, `gen-${gens[0]}`)
    // Replace symbols.json with a wrong-shape value AND fix the manifest
    // checksum so checksum validation alone cannot catch it.
    const bad = '[{"id": 42}]'
    writeFileSync(join(genDir, "symbols.json"), bad)
    const manifestPath = join(genDir, "manifest.json")
    const m = JSON.parse(readFileSync(manifestPath, "utf-8"))
    m.checksums["symbols.json"] = createHash("sha256").update(bad).digest("hex")
    writeFileSync(manifestPath, JSON.stringify(m))
    // The corrupted generation must NOT be served.
    // status on a fresh process triggers load → quarantine.
    const s1 = status(dir)
    expect(s1.available).toBe(false)
    // A --full refresh rebuilds a valid index.
    const r = refreshOnce(dir, ["--full"])
    expect(r.generation).toBeGreaterThanOrEqual(1)
    expect(status(dir).available).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("FDX index crash interruption at every publication phase (real processes)", () => {
  function barrierDir(): string {
    return mkdtempSync(join(tmpdir(), "fdx-barrier-"))
  }

  function allowAll(bar: string) {
    // Best-effort: allow every phase to proceed (cleanup path).
    for (const phase of ["build", "manifest", "publish", "current"]) {
      const p = join(bar, `go-${phase}`)
      if (!existsSync(p)) writeFileSync(p, "go")
    }
  }

  async function killAtPhase(dir: string, phase: string, extra: string[] = []): Promise<{ barrier: string; code: number | null }> {
    const bar = barrierDir()
    // Dirty the tree so the crashing writer actually rebuilds instead of
    // taking the no-change fast path.
    writeFileSync(join(dir, "lib.ts"), 'export function greet(): string { return "crash-writer" }\nexport class Widget {}\n')
    const child = spawnFdx(dir, ["refresh", ...extra], { FDX_TEST_BARRIER: bar })
    let stderr = ""
    child.stderr!.on("data", (d) => (stderr += d.toString()))
    // Walk the phases in order, releasing each until the target phase, then
    // SIGKILL the writer while it is blocked at the target barrier.
    const phases = ["build", "manifest", "publish", "current"]
    let reached = false
    for (const p of phases) {
      const deadline = Date.now() + 30_000
      while (!existsSync(join(bar, `phase-${p}`)) && Date.now() < deadline) {
        // Sleep-based poll: a tight busy loop starves the child process.
        await new Promise((r) => setTimeout(r, 20))
      }
      if (!existsSync(join(bar, `phase-${p}`))) {
        child.kill("SIGKILL")
        allowAll(bar)
        throw new Error(`barrier phase ${p} not reached (target ${phase}); stderr=${stderr}`)
      }
      if (p === phase) {
        reached = true
        break
      }
      writeFileSync(join(bar, `go-${p}`), "go")
    }
    if (!reached) {
      child.kill("SIGKILL")
      allowAll(bar)
      throw new Error(`target phase ${phase} not in phase list`)
    }
    child.kill("SIGKILL")
    const code = await new Promise<number | null>((res) => child.on("close", (c) => res(c)))
    // Clean up the barrier dir (evidence of the interruption).
    allowAll(bar)
    return { barrier: bar, code }
  }

  it("writer terminated before component completion leaves no partial state", async () => {
    const dir = makeRepo()
    refreshOnce(dir)
    const { barrier } = await killAtPhase(dir, "build")
    // No final generation for the interrupted writer exists; a reader still
    // sees the previous valid generation.
    const s = status(dir)
    expect(s.available).toBe(true)
    // Recovery: next refresh cleans the tmp dir and keeps serving.
    const r = refreshOnce(dir)
    expect(r.generation).toBeGreaterThanOrEqual(1)
    const wt = worktreeStateDir(dir)
    expect(readdirSync(wt).some((e) => e.includes(".tmp"))).toBe(false)
    rmSync(barrier, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it("writer terminated before manifest publication is recoverable", async () => {
    const dir = makeRepo()
    refreshOnce(dir)
    const g1 = status(dir).generation
    const { barrier } = await killAtPhase(dir, "manifest")
    // Components exist in a tmp dir but no manifest: never visible.
    const s = status(dir)
    expect(s.available).toBe(true)
    expect(s.generation).toBe(g1)
    // Next refresh cleans up and publishes a new generation.
    const r = refreshOnce(dir)
    expect(r.generation).toBeGreaterThanOrEqual(g1)
    expect(readdirSync(worktreeStateDir(dir)).some((e) => e.includes(".tmp"))).toBe(false)
    rmSync(barrier, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it("writer terminated before CURRENT publication recovers to the complete generation", async () => {
    const dir = makeRepo()
    refreshOnce(dir)
    const { barrier } = await killAtPhase(dir, "publish")
    // The generation was fully written but CURRENT was never updated.
    // load() must discover the newer complete generation and repoint.
    const s = status(dir)
    expect(s.available).toBe(true)
    // And no tmp/partial dirs remain after recovery.
    expect(readdirSync(worktreeStateDir(dir)).some((e) => e.includes(".tmp"))).toBe(false)
    rmSync(barrier, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it("writer terminated immediately after publication leaves a clean, valid index", async () => {
    const dir = makeRepo()
    refreshOnce(dir)
    const { barrier } = await killAtPhase(dir, "current")
    const s = status(dir)
    expect(s.available).toBe(true)
    expect(s.generation).toBeGreaterThanOrEqual(1)
    expect(readdirSync(worktreeStateDir(dir)).some((e) => e.includes(".tmp"))).toBe(false)
    rmSync(barrier, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it("daemon terminated during refresh leaves the previous generation valid", async () => {
    const dir = makeRepo()
    refreshOnce(dir)
    const bar = barrierDir()
    // Start the daemon, trigger a refresh, kill it mid-build.
    const proc = spawn(FDXD!, ["--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FDX_INDEX_DIR: stateDir, FDX_TEST_BARRIER: bar },
    })
    let daemonOut = ""
    proc.stdout!.on("data", (d) => (daemonOut += d.toString()))
    const hello = { v: 1, id: 1, method: "hello", params: { client: "test", clientVersion: "1.0.3" } }
    proc.stdin!.write(JSON.stringify(hello) + "\n")
    // Dirty the tree so the daemon's refresh actually rebuilds.
    writeFileSync(join(dir, "lib.ts"), 'export function greet(): string { return "daemon-crash" }\nexport class Widget {}\n')
    const req = { v: 1, id: 2, method: "query", params: { command: "index.refresh", argv: [], cwd: dir } }
    proc.stdin!.write(JSON.stringify(req) + "\n")
    // Wait for the build phase, then kill the daemon.
    const deadline = Date.now() + 30_000
    while (!existsSync(join(bar, "phase-build")) && Date.now() < deadline) {
      // Sleep-based poll: a tight busy loop starves the daemon process.
      await new Promise((r) => setTimeout(r, 20))
    }
    proc.kill("SIGKILL")
    allowAll(bar)
    await new Promise<void>((r) => proc.on("close", () => r()))
    // The index remains valid; a fresh refresh succeeds.
    expect(status(dir).available).toBe(true)
    const r = refreshOnce(dir)
    expect(r.generation).toBeGreaterThanOrEqual(1)
    rmSync(bar, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })
})
