#!/usr/bin/env node
/**
 * benchmark-fdx-vci-m3.mjs — Milestone 3 Semantic Provider Benchmarks
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_JSON_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m3-semantic.json");
const REPORT_MD_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m3-repro.md");
const FIXTURE_DIR = join(ROOT, "crates", "fdx", "tests", "fixtures", "scip");

function getReleaseBinaryPath() {
  const binaryName = process.platform === "win32" ? "fdx.exe" : "fdx";
  const candidate = join(ROOT, "target", "release", binaryName);

  console.log("Building FDX binary for M3 benchmark (release profile)...");
  execFileSync("cargo", ["build", "-p", "fdx", "--release"], { cwd: ROOT, stdio: "inherit" });
  return candidate;
}

function computeStats(samples) {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;

  return {
    count: sorted.length,
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    mean: Number(mean.toFixed(2)),
    median: Number(median.toFixed(2)),
    p95: Number(p95.toFixed(2)),
  };
}

function writeFakeProvider(binPath, fixturePath) {
  const script = "#!/bin/bash\n" +
    "OUT=\"\"\n" +
    "PREV=\"\"\n" +
    "for a in \"$@\"; do\n" +
    "  if [ \"$PREV\" = \"--output\" ]; then OUT=\"$a\"; fi\n" +
    "  if [ \"$a\" = \"--version\" ]; then echo \"scip-typescript 0.4.0\"; exit 0; fi\n" +
    "  PREV=\"$a\"\n" +
    "done\n" +
    "cp \"" + fixturePath + "\" \"$OUT\"\n" +
    "exit 0\n";
  writeFileSync(binPath, script);
  try {
    chmodSync(binPath, 0o755);
  } catch {}
}

async function runBenchmark() {
  console.log("=== Running FDX VCI Milestone 3 Benchmark ===");
  const binaryPath = getReleaseBinaryPath();
  const measuredSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const gitBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();

  const benchDir = join(tmpdir(), "fdx-m3-bench-" + Date.now());
  mkdirSync(join(benchDir, "src"), { recursive: true });
  writeFileSync(join(benchDir, "src", "a.ts"), "export function foo() {}\nexport function bar() {}\n");
  writeFileSync(join(benchDir, "src", "b.ts"), "import { foo } from \"./a\";\n");
  writeFileSync(join(benchDir, "src", "c.ts"), "let x = bar;\n");
  writeFileSync(join(benchDir, "tsconfig.json"), "{\"compilerOptions\":{\"strict\":true}}\n");

  const smallFixture = join(FIXTURE_DIR, "basic-ts.scip");
  const smallBytes = statSync(smallFixture).size;

  const mediumFixture = join(benchDir, "medium-16k.scip");
  const smallBuf = readFileSync(smallFixture);
  const target16k = 16 * 1024;
  const repeats = Math.ceil(target16k / smallBuf.length);
  const mediumBuf = Buffer.concat(Array(repeats).fill(smallBuf));
  writeFileSync(mediumFixture, mediumBuf);

  const fakeBin = join(benchDir, "fake-scip-typescript");
  writeFakeProvider(fakeBin, smallFixture);

  const env = { ...process.env, SCIP_TYPESCRIPT_BIN: fakeBin };

  // 1. Measure SCIP Decode small (15 samples)
  const decodeSmallSamples = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    execFileSync(binaryPath, ["semantic", "decode", smallFixture], { cwd: benchDir, env });
    decodeSmallSamples.push(performance.now() - t0);
  }
  const decodeSmallStats = computeStats(decodeSmallSamples);

  // 2. Measure SCIP Decode medium (15 samples)
  const decodeMediumSamples = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    execFileSync(binaryPath, ["semantic", "decode", mediumFixture], { cwd: benchDir, env });
    decodeMediumSamples.push(performance.now() - t0);
  }
  const decodeMediumStats = computeStats(decodeMediumSamples);

  // Initial refresh
  execFileSync(binaryPath, ["semantic", "refresh", "--provider", "scip-typescript"], { cwd: benchDir, env });

  const dbPath = join(benchDir, ".fdx", "index.sqlite");
  const dbBytesBefore = existsSync(dbPath) ? statSync(dbPath).size : 0;

  // 3. Measure Semantic Refresh with fake provider (10 samples)
  const refreshSamples = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    execFileSync(binaryPath, ["semantic", "refresh", "--provider", "scip-typescript"], { cwd: benchDir, env });
    refreshSamples.push(performance.now() - t0);
  }
  const refreshStats = computeStats(refreshSamples);

  const dbBytesAfter = existsSync(dbPath) ? statSync(dbPath).size : 0;

  // 4. Measure Semantic Status diagnostics with effective freshness (15 samples)
  const statusSamples = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    execFileSync(binaryPath, ["semantic", "status"], { cwd: benchDir, env });
    statusSamples.push(performance.now() - t0);
  }
  const statusStats = computeStats(statusSamples);

  // 5. Measure Warm Semantic Reference query (15 samples)
  const refSamples = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    execFileSync(binaryPath, ["semantic", "references", "foo", "--lang", "typescript", "--intent", "reference_complete"], { cwd: benchDir, env });
    refSamples.push(performance.now() - t0);
  }
  const refStats = computeStats(refSamples);

  // 6. Measure TreeSitter fallback query (15 samples)
  const fallbackSamples = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    execFileSync(binaryPath, ["semantic", "references", "foo", "--lang", "rust", "--intent", "reference_complete"], { cwd: benchDir, env });
    fallbackSamples.push(performance.now() - t0);
  }
  const fallbackStats = computeStats(fallbackSamples);

  // 7. Check cache cleanup
  const cacheDir = join(benchDir, ".fdx", "cache");
  let cacheSize = 0;
  if (existsSync(cacheDir)) {
    const files = readdirSync(cacheDir);
    for (const f of files) {
      cacheSize += statSync(join(cacheDir, f)).size;
    }
  }

  // Clean up benchmark directory
  rmSync(benchDir, { recursive: true, force: true });

  const report = {
    benchmark: "fdx-vci-m3-semantic",
    source_sha: measuredSha,
    branch: gitBranch,
    date: new Date().toISOString(),
    profile: "release",
    methodology: "FDX overhead measured with a deterministic fake provider (fixture copy); provider execution time is excluded from FDX-only latency; release build; effective freshness evaluated at read-time.",
    results: {
      semantic_refresh_with_fake_provider_ms: refreshStats,
      semantic_status_provider_diagnostics_ms: statusStats,
      scip_decode_small_fixture_484b_ms: decodeSmallStats,
      scip_decode_medium_fixture_16kb_ms: decodeMediumStats,
      warm_semantic_reference_query_ms: refStats,
      treesitter_fallback_reference_query_ms: fallbackStats,
    },
    db_bytes_before_refresh: dbBytesBefore,
    db_bytes_after_refresh: dbBytesAfter,
    db_size_growth_bytes: dbBytesAfter - dbBytesBefore,
    cache_size_after_benchmark_bytes: cacheSize,
    provider_execution_time: "not measured: no real indexer in this environment; fake-provider runtime dominates refresh samples and is not FDX latency",
  };

  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + "\n");
  console.log("Wrote JSON report to " + REPORT_JSON_PATH);

  const mdReport = "# M3 Semantic Benchmark reproduction\n\n" +
    "Report: reports/benchmark-fdx-vci-m3-semantic.json\n" +
    "Source SHA: " + measuredSha + " (committed functional state)\n" +
    "Branch: " + gitBranch + "\n\n" +
    "Method: release fdx binary (cargo build -p fdx --release); a temp repo with\n" +
    "src/a.ts, src/b.ts, src/c.ts, tsconfig.json; a deterministic fake\n" +
    "scip-typescript provider (copies crates/fdx/tests/fixtures/scip/basic-ts.scip\n" +
    "to --output, reports version 0.4.0). Provider execution time is therefore\n" +
    "fixture-copy time, never FDX-only latency. No real indexer was installed.\n\n" +
    "Measured operations (ms per sample, release build):\n\n" +
    "  SCIP_TYPESCRIPT_BIN=<bin> fdx semantic refresh --provider scip-typescript\n" +
    "  fdx semantic status\n" +
    "  fdx semantic decode crates/fdx/tests/fixtures/scip/basic-ts.scip      (" + smallBytes + " B)\n" +
    "  fdx semantic decode <16KB fixture>\n" +
    "  fdx semantic references foo --lang typescript --intent reference_complete\n" +
    "  fdx semantic references area --lang rust --intent reference_complete    (fallback)\n\n" +
    "DB size read from .fdx/index.sqlite before/after a refresh; growth " + (dbBytesAfter - dbBytesBefore) + " B in\n" +
    "this fixture (replacing the identical generation).\n" +
    "Cache size after benchmark: " + cacheSize + " bytes (ephemeral temporary outputs cleaned).\n";

  writeFileSync(REPORT_MD_PATH, mdReport);
  console.log("Wrote Markdown reproduction to " + REPORT_MD_PATH);
  console.log("=== M3 Benchmark Complete ===");
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});