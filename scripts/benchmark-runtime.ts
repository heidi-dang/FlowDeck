/**
 * Runtime Persistence Benchmark
 *
 * Measures latency of the runtime SQLite state store hot paths:
 *   1. runtimeInit          — openSqliteStateStore on a temp file
 *   2. commitTransition     — 100 atomic state+event transactions (in-memory)
 *   3. loadRunAfterRestart  — open -> createRun -> close -> reopen -> loadRun
 *   4. completePath         — commitTransition to "completed" terminal state
 *   5. cancellationPhase    — saveCancellationPhase + loadCancellationPhase
 *
 * Usage (run from repo root):
 *   bun scripts/benchmark-runtime.ts                              # candidate = current checkout
 *   bun scripts/benchmark-runtime.ts --candidate <dir> [--baseline <dir>]
 *
 * Environment variables:
 *   BENCHMARK_CANDIDATE_DIR  (equivalent to --candidate)
 *   BENCHMARK_BASELINE_DIR   (equivalent to --baseline)
 *
 * When both candidate and baseline are provided, the baseline is measured
 * with the same workload and the script exits 1 if the candidate regresses
 * by more than 20% on any metric. If the baseline directory does not contain
 * the runtime module (e.g. an older SHA), it warns and reports candidate only.
 *
 * Results are written to benchmark-results/runtime-benchmark.txt and .json.
 */

import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type {
  State,
  StateStore,
  ContractRecord,
  TransitionEvent,
} from "../src/orchestration/runtime/state-store.js";

const BASELINE_SHA = "5809fcf1230ff349ff0d7f5b53ed75403f44573b";
/** Runtime-compatible implementation SHA (has the runtime module). */
const RUNTIME_COMPATIBLE_SHA = "e22e04b38e45405b4ae9f15115012d0dce99c241";
const OUTPUT_DIR = "benchmark-results";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");

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

async function benchRuntimeInit(mod: RuntimeModule): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const dir = mkdtempSync(join(tmpdir(), "rt-bench-init-"));
    const dbPath = join(dir, "bench.db");
    const t0 = performance.now();
    const store = mod.openSqliteStateStore(dbPath);
    samples.push(performance.now() - t0);
    await store.close?.();
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

  let expectedVersion = 0;
  let current: State = "created" as State;
  for (let i = 0; i < 100; i++) {
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
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const dir = mkdtempSync(join(tmpdir(), "rt-bench-restart-"));
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
  }
  return samples;
}

async function benchCompletePath(mod: RuntimeModule): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
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
  for (let i = 0; i < 10; i++) {
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
      if (deltaPercent > 20) {
        regressions.push({ metric: id, baselineMs: b, candidateMs: c, deltaPercent });
      }
    }
  }
  return regressions;
}

function buildReport(opts: {
  candidateDir: string;
  baselineDir: string | null;
  candidate: Metrics;
  baseline: Metrics | null;
}): string {
  const lines: string[] = [];
  lines.push("=== Runtime Benchmark Report ===");
  lines.push(`Baseline SHA: ${BASELINE_SHA}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Candidate: ${opts.candidateDir}`);
  lines.push(`Baseline: ${opts.baselineDir ?? "(none — candidate only)"}`);
  lines.push(
    `Mode: ${opts.baseline ? "baseline-vs-candidate" : "candidate-only"}`,
  );
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
  if (opts.baseline) {
    const regressions = computeRegressions(opts.baseline, opts.candidate);
    lines.push("Comparison (candidate vs baseline, median):");
    for (const id of METRIC_IDS) {
      const b = opts.baseline[id].medianMs;
      const c = opts.candidate[id].medianMs;
      const delta = b > 0 ? (((c - b) / b) * 100).toFixed(1) : "n/a";
      lines.push(
        `  ${id.padEnd(22)} baseline ${String(b).padStart(8)} ms -> candidate ${String(c).padStart(8)} ms  (${delta}%)`,
      );
    }
    if (regressions.length === 0) {
      lines.push("");
      lines.push("Overall: PASS — no regressions > 20%");
    } else {
      lines.push("");
      lines.push("Overall: FAILED — regressions detected:");
      for (const r of regressions) {
        lines.push(
          `  ${r.metric}: +${r.deltaPercent.toFixed(1)}% (baseline ${r.baselineMs} ms -> candidate ${r.candidateMs} ms)`,
        );
      }
    }
  }

  return lines.join("\n");
}

/**
 * Resolve the git HEAD SHA of a directory, or null when not a git repo.
 * Never throws — benchmarks must degrade gracefully on git errors.
 */
function gitHeadSha(dir: string): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd: dir, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Determine whether a directory has uncommitted changes (dirty working tree).
 * `dirty=false` in the artifact means the benchmark ran against a clean checkout.
 */
function isDirty(dir: string): boolean {
  try {
    const out = execSync("git status --porcelain", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    // Not a git repo or git unavailable — treat as dirty to be conservative.
    return true;
  }
}

function parseArgs(): { baselineDir: string | null; candidateDir: string } {
  const args = process.argv.slice(2);
  let baselineDir = process.env.BENCHMARK_BASELINE_DIR ?? null;
  let candidateDir = process.env.BENCHMARK_CANDIDATE_DIR ?? null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--baseline") {
      baselineDir = args[i + 1] ?? null;
      i++;
    } else if (args[i] === "--candidate") {
      candidateDir = args[i + 1] ?? null;
      i++;
    } else if (args[i] === "--help") {
      console.log(
        `Usage: bun scripts/benchmark-runtime.ts [--candidate <dir>] [--baseline <dir>]\n` +
          `Env: BENCHMARK_CANDIDATE_DIR, BENCHMARK_BASELINE_DIR\n` +
          `Default candidate: current checkout. Exit 1 if candidate regresses > 20% vs baseline.`,
      );
      process.exit(0);
    }
  }

  return {
    baselineDir: baselineDir ? resolve(baselineDir) : null,
    candidateDir: candidateDir ? resolve(candidateDir) : REPO_ROOT,
  };
}

async function main(): Promise<void> {
  const { baselineDir, candidateDir } = parseArgs();

  const candidateMod = await loadRuntimeModule(candidateDir);
  if (!candidateMod) {
    console.error(
      `Runtime benchmark: no runtime module found at ${candidateDir} (src/orchestration/runtime/sqlite-state-store.ts missing).`,
    );
    process.exit(1);
  }

  console.log(`=== Runtime Persistence Benchmark ===`);
  console.log(`Candidate: ${candidateDir}`);
  console.log(`Baseline: ${baselineDir ?? "(none)"}`);
  console.log("");

  const candidate = await measureAll(candidateMod);

  let baseline: Metrics | null = null;
  if (baselineDir) {
    const baselineMod = await loadRuntimeModule(baselineDir);
    if (baselineMod) {
      console.log(`Measuring baseline (${baselineDir})...`);
      baseline = await measureAll(baselineMod);
    } else {
      console.warn(
        `[warn] Baseline directory ${baselineDir} has no runtime module — running candidate only.`,
      );
    }
  }

  const report = buildReport({ candidateDir, baselineDir, candidate, baseline });
  console.log("\n" + report);

  const outDir = join(process.cwd(), OUTPUT_DIR);
  mkdirSync(outDir, { recursive: true });

  const jsonPayload = {
    baselineSha: BASELINE_SHA,
    runtimeCompatibleSha: RUNTIME_COMPATIBLE_SHA,
    candidateSha: gitHeadSha(candidateDir),
    dirty: isDirty(candidateDir),
    timestamp: new Date().toISOString(),
    candidateDir,
    baselineDir,
    mode: baseline ? "baseline-vs-candidate" : "candidate-only",
    metrics: candidate,
    comparison: baseline
      ? {
          regressions: computeRegressions(baseline, candidate),
          passed: computeRegressions(baseline, candidate).length === 0,
        }
      : null,
  };

  writeFileSync(join(outDir, "runtime-benchmark.txt"), report, "utf-8");
  writeFileSync(join(outDir, "runtime-benchmark.json"), JSON.stringify(jsonPayload, null, 2), "utf-8");
  console.log(`\nResults saved to ${outDir}/`);

  if (baseline) {
    const regressions = computeRegressions(baseline, candidate);
    if (regressions.length > 0) {
      console.error(
        `\n✗ Runtime benchmark FAILED: ${regressions.length} metric(s) regressed > 20% vs baseline.`,
      );
      process.exit(1);
    }
    console.log("\n✓ No regressions > 20% vs baseline");
  }
}

main().catch((err) => {
  console.error("Runtime benchmark error:", err);
  process.exit(1);
});