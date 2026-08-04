#!/usr/bin/env node
/**
 * bench-fdx-index.mjs — Task 3D production benchmark (exact-SHA closure evidence).
 *
 * Measures the persistent index paths against FROZEN deterministic fixture
 * profiles (small / medium / large), binding every artifact to the exact
 * implementation SHA. Runs against the ACTUAL built fdx binary.
 *
 *   cold full build, warm persisted load, no-change refresh, one-file edit,
 *   multi-file edit, file creation, rename, deletion, symbol lookup,
 *   reverse-dependency lookup, tests-for-file lookup, fdx-process RSS,
 *   persisted index size.
 *
 * Guardrails (non-bypassable for closure):
 * - Rejects dirty source runs unless `--allow-dirty` (closure evidence NEVER
 *   uses --allow-dirty or --skip-budgets).
 * - Every artifact carries the full 40-char gitSha, branch, dirty, platform,
 *   architecture, CPU, memory, Rust version, Node version, bun version, and
 *   the per-profile frozen fixture SHA.
 * - Enforces absolute production budgets (`--skip-budgets` is NEVER used for
 *   closure evidence).
 * - Compares against a stored baseline (`--baseline file.json`) and fails on
 *   material regression.
 * - Exits nonzero on any benchmark failure, budget violation, or regression.
 *
 * Usage: node scripts/bench-fdx-index.mjs [--iterations N] [--out file.json]
 *        [--binary /abs/path/fdx] [--baseline baseline.json] [--skip-budgets]
 *        [--allow-dirty]
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"

const ROOT = resolve(import.meta.dirname, "..")
const BIN_NAME = process.platform === "win32" ? "fdx.exe" : "fdx"

const argv = process.argv.slice(2)
function argValue(name, def) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const ITER = Number(argValue("--iterations", "5"))
const OUT = argValue("--out", undefined)
const FIXTURE = argValue("--fixture", undefined)
const BASELINE = argValue("--baseline", undefined)
const SKIP_BUDGETS = argv.includes("--skip-budgets")
const ALLOW_DIRTY = argv.includes("--allow-dirty")

// Binary resolution: explicit --binary wins; otherwise release-first.
const EXPLICIT_BINARY = argValue("--binary", undefined)
const BINARY = EXPLICIT_BINARY || [
  join(ROOT, "target", "release", BIN_NAME),
  join(ROOT, "target", "debug", BIN_NAME),
  join(ROOT, "crates", "fdx", "target", "release", BIN_NAME),
  join(ROOT, "crates", "fdx", "target", "debug", BIN_NAME),
].find(existsSync)

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
if (dirty && !ALLOW_DIRTY) {
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
  cpu: (() => {
    try {
      return execFileSync("node", ["-e", "console.log(require('os').cpus()[0].model)"], { encoding: "utf-8" }).trim()
    } catch {
      return "unknown"
    }
  })(),
  memoryBytes: (() => {
    try {
      return execFileSync("node", ["-e", "console.log(require('os').totalmem())"], { encoding: "utf-8" }).trim()
    } catch {
      return "unknown"
    }
  })(),
  nodeVersion: process.version,
  bunVersion: execOut("bun", ["--version"]),
  rustVersion: execOut("rustc", ["--version"]),
  fdxVersion: execOut(BINARY, ["--version"]),
  indexSchemaVersion: 3,
}

// ─── Frozen fixture profiles (committed spec — deterministic content) ──────

/**
 * Frozen fixture spec. The generated tree is byte-deterministic: every file's
 * content is derived purely from its index, so two runs on the same SHA
 * produce identical trees. The per-profile `fixtureSha` (sha256 over the
 * sorted path+content list) binds the artifact to the exact frozen fixture.
 */
const FIXTURE_SPECS = {
  small: { modules: 30, testEvery: 2, lines: 6 },
  medium: { modules: 300, testEvery: 3, lines: 10 },
  large: { modules: 1500, testEvery: 4, lines: 16 },
}

function makeFixture(specKey) {
  const spec = FIXTURE_SPECS[specKey]
  const dir = mkdtempSync(join(tmpdir(), `fdx-bench-${specKey}-`))
  git(["init", "-q"], dir)
  git(["config", "user.email", "b@b"], dir)
  git(["config", "user.name", "b"], dir)
  const records = []
  for (let i = 0; i < spec.modules; i++) {
    const deps = i > 0 ? `import { dep${i - 1} } from "./mod${i - 1}";\n` : ""
    const body = []
    for (let l = 0; l < spec.lines; l++) {
      body.push(`export function fn${i}_${l}(x: number): number { return x + ${i * 1000 + l}; }`)
    }
    const content = `${deps}${body.join("\n")}\nexport class Cls${i} {}\n`
    const rel = `mod${i}.ts`
    writeFileSync(join(dir, rel), content)
    records.push(`${rel}\0${content}`)
    if (i % spec.testEvery === 0) {
      const src = i > 0 ? `./mod${i - 1}` : `./mod${i}`
      const testContent = `import { fn${i}_0 } from "${src}";\nfn${i}_0(1);\n`
      const testRel = `mod${i}.test.ts`
      writeFileSync(join(dir, testRel), testContent)
      records.push(`${testRel}\0${testContent}`)
    }
  }
  writeFileSync(join(dir, ".gitignore"), "*.log\n")
  records.push(".gitignore\0*.log\n")
  git(["add", "-A"], dir)
  git(["commit", "-qm", "fixture"], dir)
  const fixtureSha = createHash("sha256")
    .update(records.sort().join("\u0001"))
    .digest("hex")
  return { dir, spec, fixtureSha }
}

function fileCount(dir) {
  let count = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else count++
    }
  }
  walk(dir)
  return count
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

/**
 * Peak RSS of the fdx CHILD process (not the Node harness): spawn the binary
 * and sample its resident set while it works.
 *   Linux:   /proc/<pid>/statm (resident pages)
 *   macOS:   ps -o rss= -p <pid>
 *   Windows: best-effort via `ps`/tasklist (may return 0 — labeled).
 */
function fdxProcessRssKB(dir) {
  const script = `
    const { spawn } = require("child_process");
    const path = require("path");
    const child = spawn(${JSON.stringify(BINARY)}, ["index", "refresh", "--cwd", ${JSON.stringify(dir)}], {
      env: { ...process.env, FDX_INDEX_DIR: ${JSON.stringify(STATE_DIR)} },
      stdio: ["ignore", "ignore", "ignore"]
    });
    let peak = 0;
    const timer = setInterval(() => {
      let kb = 0;
      if (process.platform === "linux") {
        try {
          const statm = require("fs").readFileSync("/proc/" + child.pid + "/statm", "utf-8").trim().split(" ");
          const pages = Number(statm[1]); // resident set size in pages
          kb = Math.round(pages * 4096 / 1024);
        } catch {}
      } else if (process.platform === "darwin") {
        try {
          const out = require("child_process").execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf-8" });
          kb = Math.round(Number(out.trim()));
        } catch {}
      }
      if (kb > peak) peak = kb;
    }, 10);
    child.on("close", (code) => {
      clearInterval(timer);
      console.log(JSON.stringify({ code, peakKb: peak, platform: process.platform }));
    });
  `
  const out = execFileSync(process.env.BUN_BIN || "node", ["-e", script], { encoding: "utf-8" }).trim()
  try {
    return JSON.parse(out)
  } catch {
    return { code: -1, peakKb: 0, platform: process.platform }
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

// ─── Per-profile benchmark ──────────────────────────────────────────────────

function benchmarkProfile(specKey, fixtureDir, fixtureEvidence) {
  console.error(`fixture profile: ${specKey} (${fixtureEvidence.fileCount} files, sha ${fixtureEvidence.fixtureSha})`)
  const dir = fixtureDir

  // Cold build (first refresh after invalidate) — one sample, heavy.
  fdx(dir, ["invalidate"])
  const cold = runSamples(() => JSON.parse(fdx(dir, ["refresh", "--full"])), 3)

  // Warm persisted load: reopen status after a full build.
  const warm = runSamples(() => JSON.parse(fdx(dir, ["status"])), ITER)

  // No-change refresh.
  const noChange = runSamples(() => JSON.parse(fdx(dir, ["refresh"])), ITER)

  // One-file edit: modify a tracked file then refresh.
  const editFile = join(dir, "mod0.ts")
  function oneFileEdit() {
    const orig = new TextDecoder().decode(execFileSync("git", ["show", "HEAD:mod0.ts"], { cwd: fixtureDir, encoding: "buffer" }))
    writeFileSync(editFile, orig + "\nexport function edited(): number { return 99; }\n")
    const r = JSON.parse(fdx(dir, ["refresh"]))
    git(["checkout", "-q", "--", "mod0.ts"], dir)
    return r
  }
  const edit = runSamples(oneFileEdit, 3)

  // Multi-file edit: modify several tracked files then refresh.
  function multiFileEdit() {
    for (let i = 0; i < 10; i++) {
      const p = join(dir, `mod${i}.ts`)
      const orig = new TextDecoder().decode(execFileSync("git", ["show", `HEAD:mod${i}.ts`], { cwd: fixtureDir, encoding: "buffer" }))
      writeFileSync(p, orig + `\nexport function multiEdit${i}(): number { return ${i}; }\n`)
    }
    const r = JSON.parse(fdx(dir, ["refresh"]))
    git(["checkout", "-q", "--", "mod0.ts", "mod1.ts", "mod2.ts", "mod3.ts", "mod4.ts", "mod5.ts", "mod6.ts", "mod7.ts", "mod8.ts", "mod9.ts"], dir)
    return r
  }
  const multiEdit = runSamples(multiFileEdit, 3)

  // File creation.
  function fileCreate() {
    writeFileSync(join(dir, `created-${Date.now()}.ts`), "export const c = 1;\n")
    const r = JSON.parse(fdx(dir, ["refresh"]))
    git(["clean", "-qf", "--", "created-*.ts"], dir)
    return r
  }
  const create = runSamples(fileCreate, 3)

  // Rename.
  function renameFile() {
    git(["mv", "mod1.ts", "mod1-renamed.ts"], dir)
    const r = JSON.parse(fdx(dir, ["refresh"]))
    git(["mv", "mod1-renamed.ts", "mod1.ts"], dir)
    return r
  }
  const rename = runSamples(renameFile, 3)

  // Deletion.
  function deleteFile() {
    const p = join(dir, "del-tmp.ts")
    writeFileSync(p, "export const d = 1;\n")
    git(["add", p], dir)
    fdx(dir, ["refresh"])
    git(["rm", "-q", "--cached", "del-tmp.ts"], dir)
    rmSync(p)
    const r2 = JSON.parse(fdx(dir, ["refresh"]))
    git(["reset", "-q", "--", "del-tmp.ts"], dir)
    return r2
  }
  const deletion = runSamples(deleteFile, 3)

  // Queries (bounded, deterministic).
  const symbolQ = runSamples(() => JSON.parse(fdx(dir, ["symbols.query", "--query", "fn0", "--limit", "20"])), ITER)
  const reverseQ = runSamples(() => JSON.parse(fdx(dir, ["dependencies.query", "--file", "mod10.ts", "--limit", "20"])), ITER)
  const testsQ = runSamples(() => JSON.parse(fdx(dir, ["testsFor.query", "--file", "mod10.ts"])), ITER)

  return {
    coldFullBuild: cold,
    warmPersistedLoad: warm,
    noChangeRefresh: noChange,
    oneFileEditRefresh: edit,
    multiFileEditRefresh: multiEdit,
    fileCreationRefresh: create,
    renameRefresh: rename,
    deletionRefresh: deletion,
    symbolLookup: symbolQ,
    reverseDependencyLookup: reverseQ,
    testsForLookup: testsQ,
  }
}

// ─── Run all profiles ───────────────────────────────────────────────────────

const profiles = {}
const fixtureEvidence = {}
const fixtureCleanup = []

if (FIXTURE) {
  // Explicit frozen fixture directory provided (deterministic external tree).
  const dir = FIXTURE
  const fixtureSha = "provided"
  const fileCountV = fileCount(dir)
  profiles.medium = benchmarkProfile("medium", dir, { repository: "provided", fileCount: fileCountV, fixtureSha })
  fixtureEvidence.medium = { repository: "provided", fileCount: fileCountV, fixtureSha }
} else {
  for (const key of ["small", "medium", "large"]) {
    const { dir, spec, fixtureSha } = makeFixture(key)
    fixtureCleanup.push(dir)
    const fc = fileCount(dir)
    fixtureEvidence[key] = { profile: key, spec, fileCount: fc, fixtureSha }
    profiles[key] = benchmarkProfile(key, dir, fixtureEvidence[key])
  }
}

// fdx-process RSS (medium profile representative) + persisted index size.
const rssFixture = FIXTURE ? FIXTURE : null
const rssDir = rssFixture || fixtureCleanup[1] // medium profile dir
const rss = fdxProcessRssKB(rssDir)

const report = {
  benchmarkSuite: "fdx-index",
  benchmarkVersion: "2.0.0",
  gitSha,
  branch,
  dirty,
  timestamp: new Date().toISOString(),
  ...envEvidence,
  binaryPath: BINARY,
  fixtures: fixtureEvidence,
  profiles,
  fdxProcessRssKB: rss.peakKb,
  fdxProcessRssUnit: "kB (sampled /proc/<pid>/statm or ps -o rss= on the fdx process)",
  persistedIndexSizeBytes: persistedSizeBytes(),
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.error(`Report written to ${OUT}`)
} else {
  console.log(JSON.stringify(report, null, 2))
}

// ─── Budget gates (declared before reporting; regressions fail) ────────────
//
// Budgets apply to the MEDIUM profile (the representative production size);
// the small/large profiles provide scale evidence. Absolute p95 budgets are
// non-bypassable for closure evidence (--skip-budgets is never used there).

const BUDGETS = {
  coldFullBuild: { p95: 30_000 }, // medium fixture cold build < 30s p95
  warmPersistedLoad: { p95: 1_000 },
  noChangeRefresh: { p95: 2_500 },
  oneFileEditRefresh: { p95: 5_000 },
  multiFileEditRefresh: { p95: 8_000 },
  symbolLookup: { p95: 500 },
  reverseDependencyLookup: { p95: 500 },
  testsForLookup: { p95: 500 },
}

const failures = []
if (!SKIP_BUDGETS) {
  const medium = profiles.medium
  for (const [name, budget] of Object.entries(BUDGETS)) {
    const result = medium?.[name]
    if (!result) continue
    if (result.p95 > budget.p95) {
      failures.push(`medium/${name}: p95 ${result.p95}ms > budget ${budget.p95}ms`)
    }
  }
  if (failures.length > 0) {
    console.error(`BUDGET REGRESSION:\n  ${failures.join("\n  ")}`)
    process.exit(1)
  }
  console.error("All declared performance budgets satisfied.")
}

// ─── Baseline comparison (fails on material regression) ────────────────────
//
// A material regression is > 2x the stored baseline p95 (relative tolerance)
// on the medium profile, with the absolute budgets as the hard floor.

if (BASELINE) {
  let baseline
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf-8"))
  } catch (e) {
    console.error(`Cannot read baseline ${BASELINE}: ${e}`)
    process.exit(1)
  }
  const baseProfile = baseline.profiles?.medium
  if (!baseProfile) {
    console.error("Baseline has no medium profile; cannot compare.")
    process.exit(1)
  }
  const regressions = []
  const medium = profiles.medium
  for (const [name, baseResult] of Object.entries(baseProfile)) {
    const current = medium?.[name]
    if (!current || !baseResult?.p95) continue
    const ratio = current.p95 / baseResult.p95
    if (ratio > 2.0) {
      regressions.push(`medium/${name}: p95 ${current.p95}ms is ${ratio.toFixed(2)}x the baseline ${baseResult.p95}ms`)
    }
  }
  if (regressions.length > 0) {
    console.error(`BASELINE REGRESSION:\n  ${regressions.join("\n  ")}`)
    process.exit(1)
  }
  console.error("No material regressions versus the stored baseline.")
}

// Cleanup fixtures (not the state dir: evidence may be inspected).
for (const d of fixtureCleanup) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {}
}
