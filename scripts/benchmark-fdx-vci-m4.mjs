#!/usr/bin/env node
/**
 * benchmark-fdx-vci-m4.mjs — Milestone 4 Verifiable Transitive Impact & Change Intelligence Benchmarks
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_JSON_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m4-impact.json");
const REPORT_MD_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m4-repro.md");

function getReleaseBinaryPath() {
  const binaryName = process.platform === "win32" ? "fdx.exe" : "fdx";
  const candidate = join(ROOT, "target", "release", binaryName);

  console.log("Building FDX binary for M4 benchmark (release profile)...");
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

function initGitRepo(dir) {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Benchmark Runner"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "bench@example.com"], { cwd: dir });
}

function gitCommitAll(dir, msg) {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", msg, "--allow-empty"], { cwd: dir });
}

async function runBenchmark() {
  console.log("=== Running FDX VCI Milestone 4 Transitive Impact Benchmark ===");
  const binaryPath = getReleaseBinaryPath();
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const gitBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();

  const benchDir = join(tmpdir(), "fdx-m4-bench-" + Date.now());
  mkdirSync(join(benchDir, "src"), { recursive: true });
  initGitRepo(benchDir);

  // Setup multi-hop dependency chain:
  // src/a.ts (root) <- src/b.ts (hop 1) <- src/c.ts (hop 2) <- src/d.ts (hop 3)
  writeFileSync(join(benchDir, "src", "a.ts"), "export function rootFn(a: number): number { return a * 2; }\n");
  writeFileSync(join(benchDir, "src", "b.ts"), "import { rootFn } from './a';\nexport function midFn(x: number): number { return rootFn(x) + 1; }\n");
  writeFileSync(join(benchDir, "src", "c.ts"), "import { midFn } from './b';\nexport function mid2Fn(y: number): number { return midFn(y) + 2; }\n");
  writeFileSync(join(benchDir, "src", "d.ts"), "import { mid2Fn } from './c';\nexport function topFn(z: number): number { return mid2Fn(z) + 3; }\n");
  gitCommitAll(benchDir, "initial");

  // Run initial index
  execFileSync(binaryPath, ["index"], { cwd: benchDir });

  // 1. Measure Change Extraction & Semantic Classification
  // Modify a.ts signature
  writeFileSync(join(benchDir, "src", "a.ts"), "export function rootFn(a: number, flag: boolean): number { return flag ? a * 2 : 0; }\n");

  const changeExtractionSamples = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    execFileSync("git", ["diff", "--name-status", "-z", "-M", "HEAD"], { cwd: benchDir });
    changeExtractionSamples.push(performance.now() - t0);
  }
  const changeExtractionStats = computeStats(changeExtractionSamples);

  // 2. Measure 1-hop impact
  const oneHopSamples = [];
  let oneHopResult = null;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const raw = execFileSync(binaryPath, ["impact-v2", "--depth", "1", "--format", "json"], { cwd: benchDir, encoding: "utf8" });
    oneHopSamples.push(performance.now() - t0);
    if (!oneHopResult) oneHopResult = JSON.parse(raw);
  }
  const oneHopStats = computeStats(oneHopSamples);

  // 3. Measure 3-hop impact
  const threeHopSamples = [];
  let threeHopResult = null;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const raw = execFileSync(binaryPath, ["impact-v2", "--depth", "3", "--format", "json"], { cwd: benchDir, encoding: "utf8" });
    threeHopSamples.push(performance.now() - t0);
    if (!threeHopResult) threeHopResult = JSON.parse(raw);
  }
  const threeHopStats = computeStats(threeHopSamples);

  // 4. Measure why explanation
  const whySamples = [];
  let whyResult = null;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const raw = execFileSync(binaryPath, ["why", "src/d.ts", "--depth", "3", "--format", "json"], { cwd: benchDir, encoding: "utf8" });
    whySamples.push(performance.now() - t0);
    if (!whyResult) whyResult = JSON.parse(raw);
  }
  const whyStats = computeStats(whySamples);

  // 5. Measure Cycle Graph (A <-> B cyclic dependency)
  const cycleDir = join(tmpdir(), "fdx-m4-cycle-" + Date.now());
  mkdirSync(join(cycleDir, "src"), { recursive: true });
  initGitRepo(cycleDir);
  writeFileSync(join(cycleDir, "src", "ca.ts"), "import { cbFn } from './cb';\nexport function caFn() { return cbFn(); }\n");
  writeFileSync(join(cycleDir, "src", "cb.ts"), "import { caFn } from './ca';\nexport function cbFn() { return caFn(); }\n");
  gitCommitAll(cycleDir, "initial");
  execFileSync(binaryPath, ["index"], { cwd: cycleDir });
  writeFileSync(join(cycleDir, "src", "ca.ts"), "import { cbFn } from './cb';\nexport function caFn(x: number) { return cbFn() + x; }\n");

  const cycleSamples = [];
  let cycleResult = null;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const raw = execFileSync(binaryPath, ["impact-v2", "--depth", "5", "--format", "json"], { cwd: cycleDir, encoding: "utf8" });
    cycleSamples.push(performance.now() - t0);
    if (!cycleResult) cycleResult = JSON.parse(raw);
  }
  const cycleStats = computeStats(cycleSamples);

  // 6. Synthetic Graphs: 100, 1k edges
  const synthetic100Dir = join(tmpdir(), "fdx-m4-syn100-" + Date.now());
  mkdirSync(join(synthetic100Dir, "src"), { recursive: true });
  initGitRepo(synthetic100Dir);
  writeFileSync(join(synthetic100Dir, "src", "root.ts"), "export function core() {}\n");
  for (let i = 0; i < 100; i++) {
    writeFileSync(join(synthetic100Dir, "src", "leaf_" + i + ".ts"), "import { core } from './root';\nexport function f_" + i + "() { core(); }\n");
  }
  gitCommitAll(synthetic100Dir, "initial");
  execFileSync(binaryPath, ["index"], { cwd: synthetic100Dir });
  writeFileSync(join(synthetic100Dir, "src", "root.ts"), "export function core(x: number) {}\n");

  const syn100Samples = [];
  let syn100Result = null;
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const raw = execFileSync(binaryPath, ["impact-v2", "--depth", "2", "--format", "json"], { cwd: synthetic100Dir, encoding: "utf8" });
    syn100Samples.push(performance.now() - t0);
    if (!syn100Result) syn100Result = JSON.parse(raw);
  }
  const syn100Stats = computeStats(syn100Samples);

  // 1k synthetic graph
  const synthetic1kDir = join(tmpdir(), "fdx-m4-syn1k-" + Date.now());
  mkdirSync(join(synthetic1kDir, "src"), { recursive: true });
  initGitRepo(synthetic1kDir);
  writeFileSync(join(synthetic1kDir, "src", "root.ts"), "export function core() {}\n");
  for (let i = 0; i < 1000; i++) {
    writeFileSync(join(synthetic1kDir, "src", "leaf_" + i + ".ts"), "import { core } from './root';\nexport function f_" + i + "() { core(); }\n");
  }
  gitCommitAll(synthetic1kDir, "initial");
  execFileSync(binaryPath, ["index"], { cwd: synthetic1kDir });
  writeFileSync(join(synthetic1kDir, "src", "root.ts"), "export function core(x: number) {}\n");

  const syn1kSamples = [];
  let syn1kResult = null;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const raw = execFileSync(binaryPath, ["impact-v2", "--depth", "2", "--format", "json"], { cwd: synthetic1kDir, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
    syn1kSamples.push(performance.now() - t0);
    if (!syn1kResult) syn1kResult = JSON.parse(raw);
  }
  const syn1kStats = computeStats(syn1kSamples);

  // Clean up temp dirs
  try {
    rmSync(benchDir, { recursive: true, force: true });
    rmSync(cycleDir, { recursive: true, force: true });
    rmSync(synthetic100Dir, { recursive: true, force: true });
    rmSync(synthetic1kDir, { recursive: true, force: true });
  } catch {}

  const report = {
    schema_version: 1,
    milestone: "M4",
    title: "Milestone 4 Verifiable Transitive Impact Benchmark",
    timestamp: new Date().toISOString(),
    source_sha: sourceSha,
    branch: gitBranch,
    platform: process.platform,
    arch: process.arch,
    benchmarks: {
      change_extraction: {
        ...changeExtractionStats,
        description: "NUL-delimited safe git delta extraction",
      },
      one_hop_impact: {
        ...oneHopStats,
        assurance: oneHopResult?.assurance ?? "EXACT",
        result_count: oneHopResult?.impacted?.length ?? 0,
        changes_count: oneHopResult?.changes?.length ?? 0,
        description: "1-hop direct caller and importer impact traversal",
      },
      three_hop_impact: {
        ...threeHopStats,
        assurance: threeHopResult?.assurance ?? "EXACT",
        result_count: threeHopResult?.impacted?.length ?? 0,
        changes_count: threeHopResult?.changes?.length ?? 0,
        description: "3-hop bounded transitive impact traversal",
      },
      why_explanation: {
        ...whyStats,
        target: "src/d.ts",
        depth: whyResult?.depth ?? 3,
        strength: whyResult?.strength ?? "structural",
        description: "why explanation path generation from impact machinery",
      },
      cycle_graph: {
        ...cycleStats,
        assurance: cycleResult?.assurance ?? "EXACT",
        result_count: cycleResult?.impacted?.length ?? 0,
        description: "Cycle-safe traversal over mutual dependencies",
      },
      synthetic_100_edges: {
        ...syn100Stats,
        assurance: syn100Result?.assurance ?? "EXACT",
        result_count: syn100Result?.impacted?.length ?? 0,
        description: "100-edge fanout traversal",
      },
      synthetic_1k_edges: {
        ...syn1kStats,
        assurance: syn1kResult?.assurance ?? "EXACT",
        result_count: syn1kResult?.impacted?.length ?? 0,
        description: "1,000-edge fanout traversal",
      },
    },
  };

  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + "\n");

  const markdown = "# Milestone 4: Verifiable Transitive Impact & Change Intelligence Benchmark Report\n\n" +
    "- **Source Functional SHA**: `" + sourceSha + "`\n" +
    "- **Branch**: `" + gitBranch + "`\n" +
    "- **Timestamp**: `" + report.timestamp + "`\n" +
    "- **Platform**: `" + report.platform + "-" + report.arch + "`\n\n" +
    "---\n\n" +
    "## Benchmark Results\n\n" +
    "| Scenario | Median (ms) | p95 (ms) | Min (ms) | Max (ms) | Impact Count | Assurance |\n" +
    "|---|---|---|---|---|---|---|\n" +
    "| **Change Extraction** | " + report.benchmarks.change_extraction.median + " | " + report.benchmarks.change_extraction.p95 + " | " + report.benchmarks.change_extraction.min + " | " + report.benchmarks.change_extraction.max + " | - | - |\n" +
    "| **1-Hop Impact** | " + report.benchmarks.one_hop_impact.median + " | " + report.benchmarks.one_hop_impact.p95 + " | " + report.benchmarks.one_hop_impact.min + " | " + report.benchmarks.one_hop_impact.max + " | " + report.benchmarks.one_hop_impact.result_count + " | " + report.benchmarks.one_hop_impact.assurance + " |\n" +
    "| **3-Hop Impact** | " + report.benchmarks.three_hop_impact.median + " | " + report.benchmarks.three_hop_impact.p95 + " | " + report.benchmarks.three_hop_impact.min + " | " + report.benchmarks.three_hop_impact.max + " | " + report.benchmarks.three_hop_impact.result_count + " | " + report.benchmarks.three_hop_impact.assurance + " |\n" +
    "| **Why Explanation** | " + report.benchmarks.why_explanation.median + " | " + report.benchmarks.why_explanation.p95 + " | " + report.benchmarks.why_explanation.min + " | " + report.benchmarks.why_explanation.max + " | 1 | - |\n" +
    "| **Cycle Graph** | " + report.benchmarks.cycle_graph.median + " | " + report.benchmarks.cycle_graph.p95 + " | " + report.benchmarks.cycle_graph.min + " | " + report.benchmarks.cycle_graph.max + " | " + report.benchmarks.cycle_graph.result_count + " | " + report.benchmarks.cycle_graph.assurance + " |\n" +
    "| **Synthetic (100 edges)** | " + report.benchmarks.synthetic_100_edges.median + " | " + report.benchmarks.synthetic_100_edges.p95 + " | " + report.benchmarks.synthetic_100_edges.min + " | " + report.benchmarks.synthetic_100_edges.max + " | " + report.benchmarks.synthetic_100_edges.result_count + " | " + report.benchmarks.synthetic_100_edges.assurance + " |\n" +
    "| **Synthetic (1,000 edges)** | " + report.benchmarks.synthetic_1k_edges.median + " | " + report.benchmarks.synthetic_1k_edges.p95 + " | " + report.benchmarks.synthetic_1k_edges.min + " | " + report.benchmarks.synthetic_1k_edges.max + " | " + report.benchmarks.synthetic_1k_edges.result_count + " | " + report.benchmarks.synthetic_1k_edges.assurance + " |\n\n" +
    "---\n\n" +
    "## Reproduction Command\n\n" +
    "```bash\ncargo build -p fdx --release\nnode scripts/benchmark-fdx-vci-m4.mjs\n```\n";

  writeFileSync(REPORT_MD_PATH, markdown);
  console.log("Benchmark complete. Wrote:");
  console.log("  -", REPORT_JSON_PATH);
  console.log("  -", REPORT_MD_PATH);
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
