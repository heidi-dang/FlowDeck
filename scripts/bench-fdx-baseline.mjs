#!/usr/bin/env node
/**
 * bench-fdx-baseline.mjs — Dev 3 Task 1 baseline measurement.
 *
 * Measures per-command cold-start (process spawn + parse + execute) latency
 * for the FDX native binary and the TypeScript fallback path, plus
 * output-size distribution. Deterministic fixture: the repo root itself,
 * frozen at the release SHA (worktree clean).
 *
 * Output: JSON report consumed by the implementation plan and CI gate.
 *
 * Usage: node scripts/bench-fdx-baseline.mjs [--iterations N] [--out file.json]
 */

import { execFileSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const BINARY_NAME = process.platform === "win32" ? "fdx.exe" : "fdx"
const WORKSPACE_BINARY = join(ROOT, "target", "debug", BINARY_NAME)
const CRATE_BINARY = join(ROOT, "crates", "fdx", "target", "debug", BINARY_NAME)
const BINARY = existsSync(WORKSPACE_BINARY) ? WORKSPACE_BINARY : CRATE_BINARY

const argv = process.argv.slice(2)
function argValue(name, def) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const ITER = Number(argValue("--iterations", "15"))
const OUT = argValue("--out", undefined)

function run(bin, args, env = {}) {
  const start = process.hrtime.bigint()
  const out = execFileSync(bin, args, { encoding: "utf-8", shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } })
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  return { ms, bytes: Buffer.byteLength(out) }
}

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return { n: samples.length, min: +min.toFixed(2), p50: +p50.toFixed(2), p95: +p95.toFixed(2), max: +max.toFixed(2), mean: +mean.toFixed(2) }
}

console.error(`FDX binary: ${BINARY}`)
console.error(`Iterations per command: ${ITER}`)

const report = {
  binary: BINARY,
  iterations: ITER,
  fixture: ROOT,
  binaryVersion: run(BINARY, ["--version"]).out ?? "",
  generatedAt: new Date().toISOString(),
  commands: {},
}

// Binary `--version` (pure startup, no I/O beyond env+clap)
{
  const samples = []
  for (let i = 0; i < ITER; i++) {
    try { samples.push(run(BINARY, ["--version"]).ms) } catch (e) { samples.push(-1) }
  }
  report.commands["version-startup"] = summary(samples.filter(s => s >= 0))
}

// Per-command cold calls. Each invocation is a fresh process (the current
// architecture) — this IS the cold-start cost today.
const fixtures = {
  "read": ["read", "src/tools/fdx-shared.ts", "--mode", "prototype", "--format", "json"],
  "search": ["search", "runFdx", "--path", "src", "--format", "json", "--max-matches", "20"],
  "grep": ["grep", "execFileSync", "--path", "src", "--format", "json", "--max-matches", "20"],
  "ls": ["ls", "src/tools", "--format", "json"],
  "tree": ["tree", "src", "--depth", "2", "--format", "json"],
  "outline": ["outline", "src/tools", "--format", "json"],
  "impact": ["impact", "src/tools/fdx-shared.ts", "--root", ".", "--format", "json", "--depth", "1"],
  "batch": ["batch", "src/tools/fdx*.ts", "--mode", "prototype", "--format", "json"],
  "git-status": ["git", "status", "--short"],
}

for (const [name, args] of Object.entries(fixtures)) {
  const lat = []
  const sizes = []
  for (let i = 0; i < ITER; i++) {
    try {
      const r = run(BINARY, args)
      lat.push(r.ms)
      sizes.push(r.bytes)
    } catch (e) {
      lat.push(-1)
    }
  }
  const valid = lat.filter(s => s >= 0)
  report.commands[name] = {
    ...summary(valid),
    outputBytes: summary(sizes),
  }
}

// TypeScript fallback representative path: nativeReadFallback via a small
// inline script that imports fdx-shared and invokes the fallback directly.
try {
  const fallbackScript = `
    const { nativeReadFallback } = await import(${JSON.stringify(join(ROOT, "dist", "tools", "fdx-shared.js"))})
    const r = nativeReadFallback(${JSON.stringify(join(ROOT, "src/tools/fdx-shared.ts"))}, 30, 1)
    process.stdout.write(r)
  `
  const lat = []
  for (let i = 0; i < ITER; i++) {
    const start = process.hrtime.bigint()
    execFileSync(process.execPath, ["--input-type=module", "-e", fallbackScript], { encoding: "utf-8", shell: false, stdio: ["pipe", "pipe", "pipe"] })
    lat.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  report.commands["ts-fallback-read"] = summary(lat)
} catch (e) {
  report.commands["ts-fallback-read"] = { error: String(e).slice(0, 200) }
}

if (OUT) {
  const { writeFileSync } = await import("node:fs")
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.error(`Report written to ${OUT}`)
}
console.log(JSON.stringify(report, null, 2))
