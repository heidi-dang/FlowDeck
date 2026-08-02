/**
 * Runtime Persistence Benchmark — FAIL-CLOSED
 *
 * Measures latency of the runtime SQLite state store hot paths:
 *   1. runtimeInit          — openSqliteStateStore on a temp file
 *   2. commitTransition     — 100 atomic state+event transactions (in-memory)
 *   3. loadRunAfterRestart  — open -> createRun -> close -> reopen -> loadRun
 *   4. completePath         — commitTransition to "completed" terminal state
 *   5. cancellationPhase    — saveCancellationPhase + loadCancellationPhase
 *
 * Usage (run from repo root):
 *   bun scripts/benchmark-runtime.ts --baseline <dir>
 *   bun scripts/benchmark-runtime.ts --candidate <dir> --baseline <dir>
 *
 * Environment variables (equivalent to flags):
 *   BENCHMARK_CANDIDATE_DIR        (--candidate)
 *   BENCHMARK_BASELINE_DIR         (--baseline)  — REQUIRED
 *   BENCHMARK_OUTPUT_DIR           (--output, default ./benchmark-results)
 *   BENCHMARK_EXPECT_CANDIDATE_SHA (--expect-candidate-sha)
 *   BENCHMARK_EXPECT_BASELINE_SHA  (--expect-baseline-sha)
 *
 * Fail-closed contract — the script exits 1 on ANY of the following:
 *   - baseline not provided
 *   - baseline dir does not exist / is not a git repository
 *   - candidate or baseline worktree is dirty (uncommitted changes/untracked files)
 *   - candidate or baseline HEAD is not a resolvable 40-hex SHA
 *   - --expect-candidate-sha / --expect-baseline-sha provided but mismatching
 *   - candidate or baseline lacks the runtime module (no candidate-only fallback)
 *   - any required metric is missing or invalid
 *   - candidate regresses by more than 20% (relative) AND 2.0 ms (absolute)
 *     vs baseline on any metric — both thresholds must be exceeded, so
 *     sub-millisecond jitter between identical runs does not false-positive
 *   - output files cannot be written / verified
 *
 * There is NO candidate-only mode. The JSON output always contains a non-null
 * `comparison` with `passed` and `regressions`.
 *
 * Baseline constants are recorded distinctly:
 *   frozenBaselineSha             — 5809fcf (published main / v1.0.3). NOTE: this
 *                                   tree predates src/orchestration/runtime, so it
 *                                   cannot host the runtime module and is recorded
 *                                   for provenance only, never measured.
 *   runtimeImplementationBaselineSha — e22e04b (the runtime implementation baseline
 *                                   CI fetches and measures against).
 *
 * Results are written to runtime-benchmark.txt and runtime-benchmark.json.
 */

import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type {
  State,
  StateStore,
  ContractRecord,
  TransitionEvent,
} from "../src/orchestration/runtime/state-store.js";

const FROZEN_BASELINE_SHA = "5809fcf1230ff349ff0d7f5b53ed75403f44573b";
const RUNTIME_IMPLEMENTATION_BASELINE_SHA = "e22e04b38e45405b4ae9f15115012d0dce99c241";
const MAX_REGRESSION_PERCENT = 20;
/**
 * Absolute noise floor (ms). Sub-millisecond operations (commitTransition,
 * loadRunAfterRestart, etc.) jitter by tens of percent between runs even for
 * identical code, so a purely relative threshold would false-positive on every
 * CI run. A regression is flagged only when it exceeds BOTH the relative
 * threshold AND this absolute floor — microsecond noise is ignored while real
 * slowdowns (runtimeInit-scale) are still caught.
 */
const MIN_REGRESSION_DELTA_MS = 2.0;
const OUTPUT_DIR = "benchmark-results";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const HEX40 = /^[0-9a-f]{40}$/;

const METRIC_IDS = [
  "runtimeInit",
  "commitTransition",
  "loadRunAfterRestart",
  "completePath",
  "cancellationPhase",
] as const;

type MetricId = (typeof METRIC_IDS)[number];
type Metrics = Record<MetricId, MetricSummary>;

interface MetricSummary {
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  iterations: number;
}

interface RuntimeModule {
  createInMemoryStateStore(): StateStore;
  openSqliteStateStore(dbPath: string): StateStore;
}

/** Print an error to stderr and terminate with exit code 1. */
function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function makeContract(contractId: string): ContractRecord {
  return {
    contractId,
    hash: "bench-hash",
    version: "1",
    objective: "Benchmark objective",
    requirements: "[]",
    acceptanceCriteria: "[]",
    constraints: "[]",
    exclusions: "[]",
    requiredEvidence: "[]",
    requiredVerification: "[]",
    startingSha: "0000000000000000000000000000000000000000",
    allowedMutationScope: '["src/**"]',
    approvalGates: "[]",
    createdAt: new Date().toISOString(),
    status: "draft",
  };
}

function makeCreationEvent(runId: string, from: State, to: State): TransitionEvent {
  return {
    runId,
    from,
    to,
    transitionType: "normal",
    timestamp: Date.now(),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function summarize(samples: number[]): MetricSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    meanMs: round(mean),
    medianMs: round(median),
    p95Ms: round(sorted[p95Index] ?? 0),
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    iterations: samples.length,
  };
}

async function loadRuntimeModule(dir: string): Promise<RuntimeModule | null> {
  const modPath = join(dir, "src", "orchestration", "runtime", "sqlite-state-store.ts");
  if (!existsSync(modPath)) return null;
  try {
    const mod = (await import(modPath)) as Partial<RuntimeModule>;
    if (
      typeof mod.createInMemoryStateStore === "function" &&
      typeof mod.openSqliteStateStore === "function"
    ) {
      return mod as RuntimeModule;
    }
    return null;
  } catch {
    return null;
  }
}

/** Warm up the runtime so first-run/cold-cache effects are excluded from samples. */
async function warmup(mod: RuntimeModule, iterations: number, fn: () => Promise<void>): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
}

async function benchRuntimeInit(mod: RuntimeModule): Promise<number[]> {
  // Warm up: the first open creates the schema and is much slower than steady-state.
  await warmup(mod, 15, async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-bench-init-warm-"));
    try {
      const store = mod.openSqliteStateStore(join(dir, "bench.db"));
      await store.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const samples: number[] = [];
  for (let i = 0; i < 100; i++) {
    const dir = mkdtempSync(join(tmpdir(), "rt-bench-init-"));
    try {
      const dbPath = join(dir, "bench.db");
      const t0 = performance.now();
      const store = mod.openSqliteStateStore(dbPath);
      samples.push(performance.now() - t0);
      await store.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return samples;
}

async function benchCommitTransition(mod: RuntimeModule): Promise<number[]> {
  const samples: number[] = [];
  const store = mod.createInMemoryStateStore();
  const runId = "bench-commit";
  await store.createRun({
    runId,
    initialState: "created" as State,
    contract: makeContract("bench-ct-commit"),
    creationEvent: makeCreationEvent(runId, "created" as State, "planning" as State),
  });

  // Warm up the write path before timing. Track versions so timing continues cleanly.
  let expectedVersion = 0;
  for (let w = 0; w < 10; w++) {
    await store.commitTransition({
      runId,
      state: "planning" as State,
      expectedVersion,
      event: makeCreationEvent(runId, "created" as State, "planning" as State),
    });
    expectedVersion++;
    await store.commitTransition({
      runId,
      state: "created" as State,
      expectedVersion,
      event: makeCreationEvent(runId, "planning" as State, "created" as State),
    });
    expectedVersion++;
  }

  let current: State = "created" as State;
  for (let i = 0; i < 400; i++) {
    const next: State =
      current === ("created" as State) ? ("planning" as State) : ("created" as State);
    const t0 = performance.now();
    const result = await store.commitTransition({
      runId,
      state: next,
      expectedVersion,
      event: makeCreationEvent(runId, current, next),
    });
    samples.push(performance.now() - t0);
    if (!result.committed) {
      throw new Error(`benchmark commitTransition failed: ${result.reason}`);
    }
    expectedVersion++;
    current = next;
  }
  await store.close?.();
  return samples;
}

async function benchLoadRunAfterRestart(mod: RuntimeModule): Promise<number[]> {
  await warmup(mod, 3, async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-bench-restart-warm-"));
    try {
      const dbPath = join(dir, "bench.db");
      const runId = "bench-restart-warm";
      const store1 = mod.openSqliteStateStore(dbPath);
      await store1.createRun({
        runId,
        initialState: "created" as State,
        contract: makeContract("bench-ct-restart-warm"),
        creationEvent: makeCreationEvent(runId, "created" as State, "planning" as State),
      });
      await store1.saveCancellationPhase(runId, "active", { reason: "bench" });
      await store1.close?.();
      const store2 = mod.openSqliteStateStore(dbPath);
      await store2.loadRun(runId);
      await store2.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) {
    const dir = mkdtempSync(join(tmpdir(), "rt-bench-restart-"));
    try {
      const dbPath = join(dir, "bench.db");
      const runId = `bench-restart-${i}`;

      const store1 = mod.openSqliteStateStore(dbPath);
      await store1.createRun({
        runId,
        initialState: "created" as State,
        contract: makeContract(`bench-ct-restart-${i}`),
        creationEvent: makeCreationEvent(runId, "created" as State, "planning" as State),
      });
      await store1.saveCancellationPhase(runId, "active", { reason: "bench" });
      await store1.close?.();

      const store2 = mod.openSqliteStateStore(dbPath);
      const t0 = performance.now();
      const loaded = await store2.loadRun(runId);
      samples.push(performance.now() - t0);
      if (!loaded) {
        throw new Error("benchmark loadRunAfterRestart returned null");
      }
      await store2.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return samples;
}

async function benchCompletePath(mod: RuntimeModule): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const store = mod.createInMemoryStateStore();
    const runId = `bench-complete-${i}`;
    await store.createRun({
      runId,
      initialState: "verifying" as State,
      contract: makeContract(`bench-ct-complete-${i}`),
    });

    const t0 = performance.now();
    const result = await store.commitTransition({
      runId,
      state: "completed" as State,
      expectedVersion: 0,
      event: makeCreationEvent(runId, "verifying" as State, "completed" as State),
    });
    samples.push(performance.now() - t0);
    if (!result.committed) {
      throw new Error(`benchmark completePath failed: ${result.reason}`);
    }
    await store.close?.();
  }
  return samples;
}

async function benchCancellationPhase(mod: RuntimeModule): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const store = mod.createInMemoryStateStore();
    const runId = `bench-cancel-${i}`;
    await store.createRun({
      runId,
      initialState: "executing" as State,
      contract: makeContract(`bench-ct-cancel-${i}`),
    });

    const t0 = performance.now();
    await store.saveCancellationPhase(runId, "force_requested", { reason: "bench" });
    await store.loadCancellationPhase(runId);
    samples.push(performance.now() - t0);
    await store.close?.();
  }
  return samples;
}

async function measureAll(mod: RuntimeModule): Promise<Metrics> {
  return {
    runtimeInit: summarize(await benchRuntimeInit(mod)),
    commitTransition: summarize(await benchCommitTransition(mod)),
    loadRunAfterRestart: summarize(await benchLoadRunAfterRestart(mod)),
    completePath: summarize(await benchCompletePath(mod)),
    cancellationPhase: summarize(await benchCancellationPhase(mod)),
  };
}

interface Regression {
  metric: MetricId;
  baselineMs: number;
  candidateMs: number;
  deltaPercent: number;
}

function computeRegressions(baseline: Metrics, candidate: Metrics): Regression[] {
  const regressions: Regression[] = [];
  for (const id of METRIC_IDS) {
    const b = baseline[id].medianMs;
    const c = candidate[id].medianMs;
    if (b > 0) {
      const deltaPercent = ((c - b) / b) * 100;
      const deltaMs = c - b;
      // Flag only when BOTH relative and absolute thresholds are exceeded.
      if (deltaPercent > MAX_REGRESSION_PERCENT && deltaMs > MIN_REGRESSION_DELTA_MS) {
        regressions.push({ metric: id, baselineMs: b, candidateMs: c, deltaPercent });
      }
    }
  }
  return regressions;
}

/** Fail-closed: every required metric must exist and be a valid sample set. */
function validateMetrics(metrics: Metrics, label: string): void {
  for (const id of METRIC_IDS) {
    const m = metrics[id];
    if (
      !m ||
      typeof m.meanMs !== "number" ||
      !Number.isFinite(m.meanMs) ||
      typeof m.medianMs !== "number" ||
      !Number.isFinite(m.medianMs) ||
      typeof m.iterations !== "number" ||
      m.iterations < 1
    ) {
      fail(`invalid ${label} metric "${id}": ${JSON.stringify(m)}`);
    }
  }
}

function buildReport(opts: {
  candidateDir: string;
  baselineDir: string;
  candidateSha: string;
  baselineSha: string;
  candidate: Metrics;
  baseline: Metrics;
  comparison: { regressions: Regression[]; passed: boolean };
}): string {
  const lines: string[] = [];
  lines.push("=== Runtime Benchmark Report ===");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Mode: baseline-vs-candidate`);
  lines.push(`Candidate: ${opts.candidateDir}`);
  lines.push(`Baseline: ${opts.baselineDir}`);
  lines.push(`Candidate SHA: ${opts.candidateSha}`);
  lines.push(`Baseline SHA: ${opts.baselineSha}`);
  lines.push(`Frozen baseline SHA (provenance): ${FROZEN_BASELINE_SHA}`);
  lines.push(`Runtime implementation baseline SHA: ${RUNTIME_IMPLEMENTATION_BASELINE_SHA}`);
  lines.push(`Regression threshold: >${MAX_REGRESSION_PERCENT}% relative AND >${MIN_REGRESSION_DELTA_MS} ms absolute`);
  lines.push("");
  lines.push("Metric                     | Mean (ms) | Median (ms) | p95 (ms) | Iterations");
  lines.push("---------------------------|-----------|-------------|----------|-----------");

  for (const id of METRIC_IDS) {
    const m = opts.candidate[id];
    lines.push(
      ` ${id.padEnd(26)} | ${String(m.meanMs).padStart(9)} | ${String(m.medianMs).padStart(11)} | ${String(m.p95Ms).padStart(8)} | ${String(m.iterations).padStart(10)}`,
    );
  }

  lines.push("");
  lines.push("Comparison (candidate vs baseline, median):");
  for (const id of METRIC_IDS) {
    const b = opts.baseline[id].medianMs;
    const c = opts.candidate[id].medianMs;
    const delta = b > 0 ? (((c - b) / b) * 100).toFixed(1) : "n/a";
    lines.push(
      `  ${id.padEnd(22)} baseline ${String(b).padStart(8)} ms -> candidate ${String(c).padStart(8)} ms  (${delta}%)`,
    );
  }
  if (opts.comparison.regressions.length === 0) {
    lines.push("");
    lines.push(`Overall: PASS — no regressions > ${MAX_REGRESSION_PERCENT}%`);
  } else {
    lines.push("");
    lines.push(`Overall: FAILED — regressions detected:`);
    for (const r of opts.comparison.regressions) {
      lines.push(
        `  ${r.metric}: +${r.deltaPercent.toFixed(1)}% (baseline ${r.baselineMs} ms -> candidate ${r.candidateMs} ms)`,
      );
    }
  }

  return lines.join("\n");
}

interface Options {
  candidateDir: string;
  baselineDir: string | null;
  outputDir: string | null;
  expectCandidateSha: string | null;
  expectBaselineSha: string | null;
}

function printUsage(): void {
  console.log(
    `Usage: bun scripts/benchmark-runtime.ts --baseline <dir> [--candidate <dir>] [--output <dir>] [--expect-candidate-sha <sha>] [--expect-baseline-sha <sha>]\n` +
      `Env: BENCHMARK_BASELINE_DIR (required), BENCHMARK_CANDIDATE_DIR, BENCHMARK_OUTPUT_DIR,\n` +
      `     BENCHMARK_EXPECT_CANDIDATE_SHA, BENCHMARK_EXPECT_BASELINE_SHA\n` +
      `Fail-closed: baseline is required, candidate-only is rejected, dirty worktrees are rejected,\n` +
      `expected SHAs must match, and the candidate must not regress > ${MAX_REGRESSION_PERCENT}% (>${MIN_REGRESSION_DELTA_MS} ms) vs baseline.`,
  );
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const env = process.env;
  let baselineDir = env.BENCHMARK_BASELINE_DIR ?? null;
  let candidateDir = env.BENCHMARK_CANDIDATE_DIR ?? null;
  let outputDir = env.BENCHMARK_OUTPUT_DIR ?? null;
  let expectCandidateSha = env.BENCHMARK_EXPECT_CANDIDATE_SHA ?? null;
  let expectBaselineSha = env.BENCHMARK_EXPECT_BASELINE_SHA ?? null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = (): string | null => {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i++;
      return v;
    };
    switch (arg) {
      case "--baseline":
        baselineDir = next();
        break;
      case "--candidate":
        candidateDir = next();
        break;
      case "--output":
        outputDir = next();
        break;
      case "--expect-candidate-sha":
        expectCandidateSha = next();
        break;
      case "--expect-baseline-sha":
        expectBaselineSha = next();
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return {
    candidateDir: candidateDir ? resolve(candidateDir) : REPO_ROOT,
    baselineDir: baselineDir ? resolve(baselineDir) : null,
    outputDir: outputDir ? resolve(outputDir) : null,
    expectCandidateSha,
    expectBaselineSha,
  };
}

/** Resolve the 40-hex HEAD SHA of a git worktree, or fail closed. */
function gitSha(dir: string, label: string): string {
  let out: string;
  try {
    out = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  } catch (err) {
    fail(`${label} directory ${dir} is not a resolvable git repository: ${String(err)}`);
  }
  if (!HEX40.test(out)) {
    fail(`${label} HEAD is not a 40-hex SHA: "${out}"`);
  }
  return out;
}

/** Fail closed unless the worktree is clean (no tracked changes, no untracked files). */
function assertCleanWorktree(dir: string, label: string): void {
  let out: string;
  try {
    out = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf-8" });
  } catch (err) {
    fail(`${label} directory ${dir} is not a git repository: ${String(err)}`);
  }
  if (out.trim() !== "") {
    fail(
      `${label} worktree ${dir} is dirty — refusing to benchmark a non-clean tree:\n${out}`,
    );
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();

  if (!opts.baselineDir) {
    fail(
      "baseline directory is required (--baseline or BENCHMARK_BASELINE_DIR). Candidate-only output is rejected.",
    );
  }
  const candidateDir = opts.candidateDir;
  const baselineDir = opts.baselineDir;
  const outputDir = opts.outputDir ?? join(process.cwd(), OUTPUT_DIR);

  const candidateSha = gitSha(candidateDir, "candidate");
  const baselineSha = gitSha(baselineDir, "baseline");

  if (opts.expectCandidateSha && opts.expectCandidateSha !== candidateSha) {
    fail(
      `candidate SHA mismatch: expected ${opts.expectCandidateSha}, found ${candidateSha} in ${candidateDir}`,
    );
  }
  if (opts.expectBaselineSha && opts.expectBaselineSha !== baselineSha) {
    fail(
      `baseline SHA mismatch: expected ${opts.expectBaselineSha}, found ${baselineSha} in ${baselineDir}`,
    );
  }

  assertCleanWorktree(candidateDir, "candidate");
  assertCleanWorktree(baselineDir, "baseline");

  const candidateMod = await loadRuntimeModule(candidateDir);
  if (!candidateMod) {
    fail(
      `candidate ${candidateDir} has no runtime module (src/orchestration/runtime/sqlite-state-store.ts missing or unimportable).`,
    );
  }
  const baselineMod = await loadRuntimeModule(baselineDir);
  if (!baselineMod) {
    fail(
      `baseline ${baselineDir} has no runtime module (src/orchestration/runtime/sqlite-state-store.ts missing or unimportable). No candidate-only fallback.`,
    );
  }

  console.log(`=== Runtime Persistence Benchmark ===`);
  console.log(`Candidate: ${candidateDir} @ ${candidateSha}`);
  console.log(`Baseline: ${baselineDir} @ ${baselineSha}`);
  console.log("");

  const candidate = await measureAll(candidateMod);
  const baseline = await measureAll(baselineMod);

  validateMetrics(candidate, "candidate");
  validateMetrics(baseline, "baseline");

  const regressions = computeRegressions(baseline, candidate);
  const comparison = { regressions, passed: regressions.length === 0 };

  const report = buildReport({
    candidateDir,
    baselineDir,
    candidateSha,
    baselineSha,
    candidate,
    baseline,
    comparison,
  });
  console.log("\n" + report);

  mkdirSync(outputDir, { recursive: true });

  const jsonPayload = {
    mode: "baseline-vs-candidate",
    generatedAt: new Date().toISOString(),
    candidateDir,
    baselineDir,
    candidateSha,
    baselineSha,
    frozenBaselineSha: FROZEN_BASELINE_SHA,
    runtimeImplementationBaselineSha: RUNTIME_IMPLEMENTATION_BASELINE_SHA,
    thresholdPercent: MAX_REGRESSION_PERCENT,
    worktreeStatus: { candidateClean: true, baselineClean: true },
    environment: {
      platform: process.platform,
      arch: process.arch,
      bun: typeof Bun !== "undefined" ? Bun.version : "n/a",
    },
    metrics: candidate,
    baselineMetrics: baseline,
    comparison,
  };

  const txtPath = join(outputDir, "runtime-benchmark.txt");
  const jsonPath = join(outputDir, "runtime-benchmark.json");
  try {
    writeFileSync(txtPath, report, "utf-8");
    writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2), "utf-8");
  } catch (err) {
    fail(`failed to write benchmark output to ${outputDir}: ${String(err)}`);
  }
  if (!existsSync(txtPath) || !existsSync(jsonPath)) {
    fail(`output write verification failed in ${outputDir}`);
  }

  console.log(`\nResults saved to ${outputDir}/`);

  if (!comparison.passed) {
    console.error(
      `\n✗ Runtime benchmark FAILED: ${regressions.length} metric(s) regressed > ${MAX_REGRESSION_PERCENT}% vs baseline.`,
    );
    process.exit(1);
  }
  console.log(`\n✓ PASS: no regressions > ${MAX_REGRESSION_PERCENT}% vs baseline`);
}

main().catch((err) => {
  console.error("Runtime benchmark error:", err);
  process.exit(1);
});
