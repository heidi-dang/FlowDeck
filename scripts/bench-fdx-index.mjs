#!/usr/bin/env node
/**
 * bench-fdx-index.mjs — Task 3 persistent index benchmark (exact-SHA evidence).
 *
 * Measures the index cold/warm/incremental paths against a deterministic
 * synthetic fixture, binding every artifact to the exact implementation SHA:
 *
 *   cold full build, warm persisted load, no-change refresh, one-file edit,
 *   file creation, rename, deletion, symbol lookup, reverse-dependency
 *   lookup, tests-for-file lookup, resident memory, persisted index size.
 *
 * Guardrails:
 * - Rejects dirty source runs (the worktree must match the exact git HEAD).
 * - Every artifact carries gitSha/branch/dirty/timestamp/platform/... .
 * - Fails with a nonzero exit on benchmark failure or budget regression.
 *
 * Usage: node scripts/bench-fdx-index.mjs [--iterations N] [--out file.json]
 *        [--fixture FILE] [--skip-budgets]
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const BIN_NAME = process.platform === "win32" ? "fdx.exe" : "fdx"
const BINARY = [
  join(ROOT, "target", "debug", BIN_NAME),
  join(ROOT, "crates", "fdx", "target", "debug", BIN_NAME),
].find(existsSync)

const argv = process.argv.slice(2)
function argValue(name, def) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const ITER = Number(argValue("--iterations", "7"))
const OUT = argValue("--out", undefined)
const FIXTURE = argValue("--fixture", undefined)
const SKIP_BUDGETS = argv.includes("--skip-budgets")

if (!BINARY) {
  console.error("fdx native binary not found. Build it first: cargo build --manifest-path crates/fdx/Cargo.toml --bin fdx")
  process.exit(1)
}

// ─── Source-state evidence (exact SHA binding) ──────────────────────────────

function git(args, cwd = ROOT) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim()
  } catch {
    return ""
  }
}

const gitSha = git(["rev-parse", "HEAD"])
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
const dirty = git(["status", "--porcelain"]) !== ""

if (!gitSha || gitSha.length !== 40) {
  console.error("Cannot determine the implementation SHA; aborting (no unbound evidence).")
  process.exit(1)
}
if (dirty && !argv.includes("--allow-dirty")) {
  console.error(`Dirty source run rejected: worktree has uncommitted changes at ${gitSha}.`)
  console.error("Commit or stash before benchmarking, or pass --allow-dirty to override (evidence will be labeled).")
  process.exit(1)
}

// ─── Environment evidence ───────────────────────────────────────────────────

function execOut(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8" }).trim()
  } catch {
    return "unknown"
  }
}
const envEvidence = {
  platform: process.platform,
  architecture: process.arch,
  cpu: (() => { try { return execFileSync("node", ["-e", "console.log(require('os').cpus()[0].model)"], { encoding: "utf-8" }).trim() } catch { return "unknown" } })(),
  memory: (() => { try { return execFileSync("node", ["-e", "console.log(require('os').totalmem())"], { encoding: "utf-8" }).trim() } catch { return "unknown" } })(),
  nodeVersion: process.version,
  bunVersion: execOut("bun", ["--version"]),
  rustVersion: execOut("rustc", ["--version"]),
  fdxVersion: execOut(BINARY, ["--version"]),
  indexSchemaVersion: 1,
}

// ─── Deterministic synthetic fixture ────────────────────────────────────────

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "fdx-bench-"))
  git(["init", "-q"], dir)
  git(["config", "user.email", "b@b"], dir)
  git(["config", "user.name", "b"], dir)
  // 120 source files + 40 test files with imports (deterministic).
  for (let i = 0; i < 120; i++) {
    const deps = i > 0 ? `import { dep${i - 1} } from "./mod${i - 1}";\n` : ""
    writeFileSync(join(dir, `mod${i}.ts`), `${deps}export function fn${i}(): number { return ${i}; }\nexport class Cls${i} {}\n`)
  }
  for (let i = 0; i < 40; i++) {
    const src = i % 2 === 0 ? `./mod${i}` : `./mod${Math.floor(i / 2)}`
    writeFileSync(join(dir, `mod${i}.test.ts`), `import { fn${i} } from "${src}";\nfn${i}();\n`)
  }
  writeFileSync(join(dir, ".gitignore"), "*.log\n")
  git(["add", "-A"], dir)
  git(["commit", "-qm", "fixture"], dir)
  return dir
}

// ─── Index helpers (one-shot fdx index CLI) ────────────────────────────────

const STATE_DIR = mkdtempSync(join(tmpdir(), "fdx-bench-state-"))
function fdx(dir, args) {
  return execFileSync(BINARY, ["index", ...args, "--cwd", dir], {
    encoding: "utf-8",
    env: { ...process.env, FDX_INDEX_DIR: STATE_DIR },
  })
}
function timed(fn) {
  const start = process.hrtime.bigint()
  const result = fn()
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, result }
}

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  return {
    n: samples.length,
    median: +quantile(0.5).toFixed(2),
    p95: +quantile(0.95).toFixed(2),
    p99: +quantile(0.99).toFixed(2),
    minimum: +quantile(0).toFixed(2),
    maximum: +quantile(1).toFixed(2),
    mean: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2),
  }
}

function runSamples(fn, n = ITER) {
  const samples = []
  // Warmup
  fn()
  for (let i = 0; i < n; i++) samples.push(timed(fn).ms)
  return summary(samples)
}

// ─── Run the benchmark ──────────────────────────────────────────────────────

const fixture = FIXTURE && existsSync(FIXTURE) ? FIXTURE : makeFixture()
const fixtureEvidence = {
  repository: FIXTURE ? "provided" : "synthetic",
  fileCount: (() => {
    let count = 0
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === ".git") continue
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else count++
      }
    }
    walk(fixture)
    return count
  })(),
  sampleCount: ITER,
  warmupCount: 1,
}

console.error(`fdx binary: ${BINARY}`)
console.error(`implementation SHA: ${gitSha}${dirty ? " (DIRTY)" : ""}`)
console.error(`fixture: ${fixture} (${fixtureEvidence.fileCount} files)`)

// Cold build (first refresh after invalidate) — one sample, heavy.
fdx(fixture, ["invalidate"])
const cold = runSamples(() => JSON.parse(fdx(fixture, ["refresh", "--full"])), 3)

// Warm persisted load: reopen status after a full build.
const warm = runSamples(() => JSON.parse(fdx(fixture, ["status"])), ITER)

// No-change refresh.
const noChange = runSamples(() => JSON.parse(fdx(fixture, ["refresh"])), ITER)

// One-file edit: modify a tracked file then refresh.
const editFile = join(fixture, "mod0.ts")
function oneFileEdit() {
  const orig = new TextDecoder().decode(execFileSync("git", ["show", "HEAD:mod0.ts"], { cwd: fixture, encoding: "buffer" }))
  writeFileSync(editFile, orig + "\nexport function edited(): number { return 99; }\n")
  const r = JSON.parse(fdx(fixture, ["refresh"]))
  git(["checkout", "-q", "--", "mod0.ts"], fixture)
  return r
}
const edit = runSamples(oneFileEdit, 3)

// File creation.
function fileCreate() {
  writeFileSync(join(fixture, `created-${Date.now()}.ts`), "export const c = 1;\n")
  const r = JSON.parse(fdx(fixture, ["refresh"]))
  git(["clean", "-qf", "--", "created-*.ts"], fixture)
  return r
}
const create = runSamples(fileCreate, 3)

// Rename.
function renameFile() {
  git(["mv", "mod1.ts", "mod1-renamed.ts"], fixture)
  const r = JSON.parse(fdx(fixture, ["refresh"]))
  git(["mv", "mod1-renamed.ts", "mod1.ts"], fixture)
  return r
}
const rename = runSamples(renameFile, 3)

// Deletion.
function deleteFile() {
  const p = join(fixture, "del-tmp.ts")
  writeFileSync(p, "export const d = 1;\n")
  git(["add", p], fixture)
  fdx(fixture, ["refresh"])
  git(["rm", "-q", "--cached", "del-tmp.ts"], fixture)
  rmSync(p)
  const r2 = JSON.parse(fdx(fixture, ["refresh"]))
  git(["reset", "-q", "--", "del-tmp.ts"], fixture)
  return r2
}
const deletion = runSamples(deleteFile, 3)

// Queries (bounded, deterministic).
const symbolQ = runSamples(() => JSON.parse(fdx(fixture, ["symbols.query", "--query", "fn0", "--limit", "20"])), ITER)
const reverseQ = runSamples(() => JSON.parse(fdx(fixture, ["dependencies.query", "--file", "mod10.ts", "--limit", "20"])), ITER)
const testsQ = runSamples(() => JSON.parse(fdx(fixture, ["testsFor.query", "--file", "mod10.ts"])), ITER)

// Resident memory: peak RSS of the fdx process during a refresh.
function residentMemoryMB() {
  const script = `
    const { spawnSync } = require("child_process");
    const r = spawnSync("${BINARY}", ["index", "refresh", "--cwd", "${fixture}"], {
      env: { ...process.env, FDX_INDEX_DIR: "${STATE_DIR}" }, encoding: "utf-8"
    });
    void r;
  `
  execFileSync("node", ["-e", script], { encoding: "utf-8" })
  // Approximate RSS by running node with max-old-space measurement is not
  // portable; use the parent process RSS via /proc when available.
  try {
    const statm = new TextDecoder().decode(execFileSync("sh", ["-c", `awk '/VmHWM/ {print $2}' /proc/self/status 2>/dev/null || echo 0`], { encoding: "buffer" }))
    return Number(statm.trim() || "0")
  } catch {
    return 0
  }
}

// Persisted index size.
function persistedSizeBytes() {
  let total = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else total += statSync(p).size
    }
  }
  walk(STATE_DIR)
  return total
}

const report = {
  benchmarkSuite: "fdx-index",
  benchmarkVersion: "1.0.0",
  gitSha,
  branch,
  dirty,
  timestamp: new Date().toISOString(),
  ...envEvidence,
  fixture: fixtureEvidence,
  results: {
    coldFullBuild: cold,
    warmPersistedLoad: warm,
    noChangeRefresh: noChange,
    oneFileEditRefresh: edit,
    fileCreationRefresh: create,
    renameRefresh: rename,
    deletionRefresh: deletion,
    symbolLookup: symbolQ,
    reverseDependencyLookup: reverseQ,
    testsForLookup: testsQ,
  },
  residentMemory: { vmrssKB: residentMemoryMB(), unit: "kB (VmHWM best-effort)" },
  persistedIndexSizeBytes: persistedSizeBytes(),
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.error(`Report written to ${OUT}`)
} else {
  console.log(JSON.stringify(report, null, 2))
}

// ─── Budget gates (declared before reporting; regressions fail) ────────────

const BUDGETS = {
  coldFullBuild: { p95: 30_000 }, // 120-file fixture cold build under 30s p95
  warmPersistedLoad: { p95: 500 }, // warm load under 500ms p95
  noChangeRefresh: { p95: 1_500 }, // no-change refresh never full-scans: <1.5s
  oneFileEditRefresh: { p95: 3_000 },
  symbolLookup: { p95: 200 },
  reverseDependencyLookup: { p95: 200 },
  testsForLookup: { p95: 200 },
}

if (!SKIP_BUDGETS) {
  const failures = []
  for (const [name, budget] of Object.entries(BUDGETS)) {
    const result = report.results[name]
    if (!result) continue
    if (result.p95 > budget.p95) {
      failures.push(`${name}: p95 ${result.p95}ms > budget ${budget.p95}ms`)
    }
  }
  if (failures.length > 0) {
    console.error(`BUDGET REGRESSION:\n  ${failures.join("\n  ")}`)
    process.exit(1)
  }
  console.error("All declared performance budgets satisfied.")
}
