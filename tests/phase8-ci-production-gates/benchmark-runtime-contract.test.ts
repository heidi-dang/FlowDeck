import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const ROOT = process.cwd()
const SCRIPT = join(ROOT, "scripts", "benchmark-runtime.ts")
const BUN = process.execPath
const RUNTIME_SRC = join(ROOT, "src", "orchestration", "runtime")

const FROZEN_BASELINE_SHA = "5809fcf1230ff349ff0d7f5b53ed75403f44573b"
const RUNTIME_IMPLEMENTATION_BASELINE_SHA = "e22e04b38e45405b4ae9f15115012d0dce99c241"

/**
 * Build a hermetic temp git repo containing only the runtime module, committed
 * at a fixed SHA. The benchmark's fail-closed paths must not depend on the
 * actual checkout state, so the tests run against these standalone repos.
 */
function makeRuntimeRepo(prefix: string): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), `rt-contract-${prefix}-`))
  const target = join(dir, "src", "orchestration", "runtime")
  cpSync(RUNTIME_SRC, target, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: dir })
  execFileSync("git", ["config", "user.email", "contract@test.local"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "Contract Test"], { cwd: dir })
  execFileSync("git", ["add", "-A"], { cwd: dir })
  execFileSync("git", ["commit", "-q", "-m", "test runtime module"], { cwd: dir })
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim()
  return { dir, sha }
}

/** Run the benchmark script and return { status, stdout, stderr, outputDir }. */
function runBenchmark(args: string[]): {
  status: number
  stdout: string
  stderr: string
  outputDir: string
} {
  const outputDir = mkdtempSync(join(tmpdir(), "rt-contract-out-"))
  try {
    const res = execFileSync(BUN, [SCRIPT, "--output", outputDir, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { status: 0, stdout: res, stderr: "", outputDir }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "", outputDir }
  }
}

const RUNTIME_METRICS = [
  "runtimeInit",
  "commitTransition",
  "loadRunAfterRestart",
  "completePath",
  "cancellationPhase",
]

describe("Phase 8 — Fail-closed runtime benchmark contract", () => {
  let baseline: { dir: string; sha: string }
  let candidate: { dir: string; sha: string }

  beforeAll(() => {
    baseline = makeRuntimeRepo("baseline")
    candidate = makeRuntimeRepo("candidate")
  })

  afterAll(() => {
    // Temp dirs are under tmpdir(); best-effort cleanup is sufficient for CI.
    for (const r of [baseline, candidate]) {
      if (existsSync(join(r.dir, ".git"))) {
        try {
          execFileSync("git", ["-C", r.dir, "worktree", "prune"])
        } catch {
          // ignore
        }
      }
    }
  })

  it("rejects missing baseline (no candidate-only fallback)", () => {
    const res = runBenchmark(["--candidate", candidate.dir])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("baseline directory is required")
  })

  it("rejects a nonexistent baseline directory", () => {
    const res = runBenchmark([
      "--candidate", candidate.dir,
      "--baseline", join(tmpdir(), "does-not-exist-rt-contract"),
    ])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("git")
  })

  it("rejects a non-git baseline directory", () => {
    const plain = mkdtempSync(join(tmpdir(), "rt-contract-plain-"))
    const res = runBenchmark(["--candidate", candidate.dir, "--baseline", plain])
    expect(res.status).toBe(1)
  })

  it("rejects a dirty candidate worktree", () => {
    const dirty = makeRuntimeRepo("dirty")
    writeFileSync(join(dirty.dir, "uncommitted.txt"), "dirty", "utf-8")
    const res = runBenchmark(["--candidate", dirty.dir, "--baseline", baseline.dir])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("dirty")
  })

  it("rejects a dirty baseline worktree", () => {
    const dirty = makeRuntimeRepo("dirty-base")
    writeFileSync(join(dirty.dir, "uncommitted.txt"), "dirty", "utf-8")
    const res = runBenchmark(["--candidate", candidate.dir, "--baseline", dirty.dir])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("dirty")
  })

  it("rejects an unexpected candidate SHA", () => {
    const res = runBenchmark([
      "--candidate", candidate.dir,
      "--baseline", baseline.dir,
      "--expect-candidate-sha", "0000000000000000000000000000000000000000",
    ])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("candidate SHA mismatch")
  })

  it("rejects an unexpected baseline SHA", () => {
    const res = runBenchmark([
      "--candidate", candidate.dir,
      "--baseline", baseline.dir,
      "--expect-baseline-sha", "0000000000000000000000000000000000000000",
    ])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("baseline SHA mismatch")
  })

  it("rejects a baseline without the runtime module (no candidate-only fallback)", () => {
    const empty = mkdtempSync(join(tmpdir(), "rt-contract-empty-"))
    execFileSync("git", ["init", "-q"], { cwd: empty })
    execFileSync("git", ["config", "user.email", "contract@test.local"], { cwd: empty })
    execFileSync("git", ["config", "user.name", "Contract Test"], { cwd: empty })
    writeFileSync(join(empty, "readme.md"), "no runtime here", "utf-8")
    execFileSync("git", ["add", "-A"], { cwd: empty })
    execFileSync("git", ["commit", "-q", "-m", "no runtime"], { cwd: empty })
    const res = runBenchmark(["--candidate", candidate.dir, "--baseline", empty])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("no runtime module")
  })

  it("rejects an unknown CLI argument", () => {
    const res = runBenchmark(["--candidate", candidate.dir, "--baseline", baseline.dir, "--bogus"])
    expect(res.status).toBe(1)
  })

  it("emits fail-closed baseline-vs-candidate evidence with comparison on success", () => {
    const res = runBenchmark(["--candidate", candidate.dir, "--baseline", baseline.dir])
    expect(res.status).toBe(0)

    const jsonPath = join(res.outputDir, "runtime-benchmark.json")
    const txtPath = join(res.outputDir, "runtime-benchmark.txt")
    expect(existsSync(jsonPath)).toBe(true)
    expect(existsSync(txtPath)).toBe(true)

    const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
      mode: string
      candidateSha: string
      baselineSha: string
      frozenBaselineSha: string
      runtimeImplementationBaselineSha: string
      metrics: Record<string, { meanMs: number; medianMs: number }>
      baselineMetrics: Record<string, { meanMs: number; medianMs: number }>
      comparison: { regressions: unknown[]; passed: boolean } | null
    }

    expect(parsed.mode).toBe("baseline-vs-candidate")
    expect(parsed.candidateSha).toBe(candidate.sha)
    expect(parsed.baselineSha).toBe(baseline.sha)
    expect(parsed.frozenBaselineSha).toBe(FROZEN_BASELINE_SHA)
    expect(parsed.runtimeImplementationBaselineSha).toBe(RUNTIME_IMPLEMENTATION_BASELINE_SHA)
    expect(parsed.comparison).not.toBeNull()
    expect(parsed.comparison?.passed).toBe(true)
    expect(parsed.comparison?.regressions).toEqual([])

    for (const metric of RUNTIME_METRICS) {
      expect(parsed.metrics[metric]).toBeDefined()
      expect(parsed.metrics[metric].meanMs).toBeGreaterThan(0)
      expect(parsed.baselineMetrics[metric]).toBeDefined()
      expect(parsed.baselineMetrics[metric].meanMs).toBeGreaterThan(0)
    }

    const txt = readFileSync(txtPath, "utf-8")
    expect(txt).toContain("Mode: baseline-vs-candidate")
    expect(txt).toContain("Overall: PASS")
  })
})
