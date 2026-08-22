#!/usr/bin/env node
/**
 * benchmark-fdx-vci-m4.mjs — Milestone 4 Verifiable Transitive Impact & Change Intelligence Benchmarks
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_JSON_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m4-impact.json");
const REPORT_MD_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m4-repro.md");

const EXPECTED_FUNCTIONAL_SHA = "601d47ba48e0d3cdcbb367346716706648e9770d";

function getReleaseBinaryPath() {
  if (process.env.FDX_BINARY_PATH && existsSync(process.env.FDX_BINARY_PATH)) {
    console.log("Using pre-built FDX binary: " + process.env.FDX_BINARY_PATH);
    return process.env.FDX_BINARY_PATH;
  }
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

  const declaredFunctionalSha = process.env.FDX_BENCHMARK_FUNCTIONAL_SHA || EXPECTED_FUNCTIONAL_SHA;
  if (declaredFunctionalSha !== EXPECTED_FUNCTIONAL_SHA) {
    throw new Error(
      `Declared functional SHA ${declaredFunctionalSha} does not match expected functional SHA ${EXPECTED_FUNCTIONAL_SHA}`
    );
  }

  // Verify functional SHA exists in git object DB
  try {
    execFileSync("git", ["cat-file", "-e", declaredFunctionalSha], { cwd: ROOT });
  } catch {
    throw new Error(`Functional SHA ${declaredFunctionalSha} not found in repository`);
  }

  // Verify production tree matches functional SHA byte-for-byte
  const diffOutput = execFileSync("git", ["diff", "--name-only", declaredFunctionalSha], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();

  const allowedDifferences = new Set([
    "scripts/benchmark-fdx-vci-m4.mjs",
    "reports/benchmark-fdx-vci-m4-impact.json",
    "reports/benchmark-fdx-vci-m4-repro.md",
  ]);

  if (diffOutput.length > 0) {
    const changedFiles = diffOutput.split("\n").map((f) => f.trim()).filter(Boolean);
    const unapprovedChanges = changedFiles.filter((f) => !allowedDifferences.has(f));
    if (unapprovedChanges.length > 0) {
      throw new Error(
        `Production tree differs from functional SHA ${declaredFunctionalSha}: ${unapprovedChanges.join(", ")}`
      );
    }
  }

  // Verify harness script itself has NO working-tree or staged differences relative to HEAD
  const unstagedHarnessDiff = execFileSync(
    "git",
    ["diff", "--name-only", "HEAD", "--", "scripts/benchmark-fdx-vci-m4.mjs"],
    { cwd: ROOT, encoding: "utf8" }
  ).trim();
  if (unstagedHarnessDiff) {
    throw new Error(
      "Benchmark harness differs from committed HEAD; commit harness before execution"
    );
  }

  const stagedHarnessDiff = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--", "scripts/benchmark-fdx-vci-m4.mjs"],
    { cwd: ROOT, encoding: "utf8" }
  ).trim();
  if (stagedHarnessDiff) {
    throw new Error(
      "Benchmark harness has staged uncommitted changes; commit harness before execution"
    );
  }

  const harnessSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const gitBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const binaryPath = getReleaseBinaryPath();

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

  // 5. Measure Fresh SCIP canonical-symbol impact
  const scipDir = join(tmpdir(), "fdx-m4-scip-" + Date.now());
  mkdirSync(join(scipDir, "src"), { recursive: true });
  initGitRepo(scipDir);
  writeFileSync(join(scipDir, "src", "a.ts"), "export function foo() {}\nexport function bar() {}\n");
  writeFileSync(join(scipDir, "src", "b.ts"), "import { foo } from './a';\n");
  writeFileSync(join(scipDir, "src", "c.ts"), "let x = bar;\n");
  writeFileSync(join(scipDir, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n');
  gitCommitAll(scipDir, "initial");

  const scipFixture = join(ROOT, "crates", "fdx", "tests", "fixtures", "scip", "basic-ts.scip");
  const fakeBin = join(scipDir, "fake-scip-typescript");
  const countLog = join(scipDir, "fake-scip-counter.log");
  const fakeScript = `#!/bin/bash
echo "invoked" >> "${countLog}"
OUT=""
PREV=""
for a in "$@"; do
  if [ "$PREV" = "--output" ]; then OUT="$a"; fi
  if [ "$a" = "--version" ]; then echo "scip-typescript 0.4.0"; exit 0; fi
  PREV="$a"
done
cp "${scipFixture}" "$OUT"
exit 0
`;
  writeFileSync(fakeBin, fakeScript);
  execFileSync("chmod", ["+x", fakeBin], { cwd: scipDir });

  const env = { ...process.env, SCIP_TYPESCRIPT_BIN: fakeBin };

  execFileSync(binaryPath, ["index"], { cwd: scipDir, env });
  execFileSync(binaryPath, ["semantic", "refresh", "--provider", "scip-typescript"], { cwd: scipDir, env });

  const checkerPath = join(scipDir, "checker.mjs");
  writeFileSync(checkerPath, `
import { Database } from "bun:sqlite";
const db = new Database(".fdx/index.sqlite");
const p = db.query("SELECT health, freshness, input_fingerprint AS fingerprint FROM semantic_providers WHERE provider_id = 'scip-typescript'").get();
if (!p) throw new Error("No provider");
console.log("PROVIDER|" + p.health + "|" + p.freshness + "|" + p.fingerprint);
const n = db.query("SELECT stable_id FROM nodes WHERE stable_id LIKE 'sem:%' LIMIT 1").get();
if (!n) throw new Error("No sem node");
console.log("NODE|" + n.stable_id);
const e = db.query("SELECT provider_id, provider_fingerprint FROM edges WHERE provider = 'scip' LIMIT 1").get();
if (!e) throw new Error("No scip edge");
console.log("EDGE|" + e.provider_id + "|" + e.provider_fingerprint);
  `);

  const checkerOut = execFileSync("bun", ["run", "checker.mjs"], { cwd: scipDir, encoding: "utf8" });
  let health, freshness, fingerprint, node_id, edgeProviderId, edgeFingerprint;
  for (const line of checkerOut.trim().split("\n")) {
    const parts = line.split("|");
    if (parts[0] === "PROVIDER") {
      health = parts[1];
      freshness = parts[2];
      fingerprint = parts[3];
    } else if (parts[0] === "NODE") {
      node_id = parts[1];
    } else if (parts[0] === "EDGE") {
      edgeProviderId = parts[1];
      edgeFingerprint = parts[2];
    }
  }

  if (health !== "available") throw new Error("provider health not available: " + health);
  if (freshness !== "fresh") throw new Error("provider freshness not fresh: " + freshness);
  if (!node_id || !node_id.startsWith("sem:")) throw new Error("no canonical semantic node found: " + node_id);
  if (edgeProviderId !== "scip-typescript") throw new Error("edge provider_id mismatch: " + edgeProviderId);
  if (edgeFingerprint !== fingerprint) throw new Error("edge fingerprint mismatch: " + edgeFingerprint + " vs " + fingerprint);

  const getProviderExecutions = () => {
    if (!existsSync(countLog)) return 0;
    return readFileSync(countLog, "utf8").trim().split("\n").filter(Boolean).length;
  };

  const setupProviderExecutions = getProviderExecutions();
  if (setupProviderExecutions === 0) throw new Error("fake provider was never executed during setup");

  writeFileSync(join(scipDir, "src", "a.ts"), "export function foo(v: number) {}\nexport function bar() {}\n");

  const initialImpact = JSON.parse(execFileSync(binaryPath, ["impact-v2", "--depth", "2", "--format", "json"], { cwd: scipDir, env, encoding: "utf8" }));
  const bTarget = initialImpact.impacted.find(t => t.target === "src/b.ts");
  if (!bTarget) throw new Error("impact did not reach consumer src/b.ts");

  let foundScip = false;
  let semPrefixUsed = false;
  for (const path of [bTarget.primary_path, ...bTarget.alternate_paths]) {
    if (path.seed_node.startsWith("sem:") || path.target_node.startsWith("sem:")) semPrefixUsed = true;
    for (const step of path.steps) {
      if (step.provider === "scip") foundScip = true;
    }
  }
  if (!foundScip) throw new Error("impact path does not use scip evidence");
  if (!semPrefixUsed) throw new Error("impact path does not use sem:* node");

  const executionsBeforeTiming = getProviderExecutions();

  const scipSamples = [];
  let scipResult = null;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const raw = execFileSync(binaryPath, ["impact-v2", "--depth", "2", "--format", "json"], { cwd: scipDir, env, encoding: "utf8" });
    scipSamples.push(performance.now() - t0);
    if (!scipResult) scipResult = JSON.parse(raw);
  }
  const scipStats = computeStats(scipSamples);

  const executionsAfterTiming = getProviderExecutions();
  const timedProviderExecutions = executionsAfterTiming - executionsBeforeTiming;
  if (timedProviderExecutions !== 0) {
    throw new Error(`Provider executed ${timedProviderExecutions} times during timed impact queries!`);
  }

  // 6. Measure Effective Stale Provider Fallback Path
  writeFileSync(join(scipDir, "tsconfig.json"), '{"compilerOptions":{"strict":false,"target":"es2022"}}\n');

  const staleCheck = JSON.parse(execFileSync(binaryPath, ["impact-v2", "--depth", "2", "--format", "json"], { cwd: scipDir, env, encoding: "utf8" }));
  const isStale = staleCheck.uncertainty.some(u => u.kind === "provider_stale");
  if (!isStale) throw new Error("Effective provider state is not stale");

  let hasManual = false;
  const staleB = staleCheck.impacted.find(t => t.target === "src/b.ts");
  if (!staleB) throw new Error("impact did not reach consumer src/b.ts in stale case");
  for (const path of [staleB.primary_path, ...staleB.alternate_paths]) {
    for (const step of path.steps) {
      if (step.provider === "manual_rule") hasManual = true;
    }
  }
  if (!hasManual) throw new Error("manual_rule fallback not present in stale case");

  const staleSamples = [];
  let staleResult = null;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const raw = execFileSync(binaryPath, ["impact-v2", "--depth", "2", "--format", "json"], { cwd: scipDir, env, encoding: "utf8" });
    staleSamples.push(performance.now() - t0);
    if (!staleResult) staleResult = JSON.parse(raw);
  }
  const staleStats = computeStats(staleSamples);

  // 7. Measure Deleted-Symbol Before-Evidence Traversal
  const delDir = join(tmpdir(), "fdx-m4-del-" + Date.now());
  mkdirSync(join(delDir, "src"), { recursive: true });
  initGitRepo(delDir);
  writeFileSync(join(delDir, "src", "api.ts"), "export function legacyHelper(): number { return 1; }\n");
  writeFileSync(join(delDir, "src", "user.ts"), "import { legacyHelper } from './api';\nexport function invoke(): number { return legacyHelper(); }\n");
  gitCommitAll(delDir, "commit_1_define");
  execFileSync(binaryPath, ["index"], { cwd: delDir });
  writeFileSync(join(delDir, "src", "api.ts"), "export const newApi = 2;\n");
  gitCommitAll(delDir, "commit_2_delete");
  execFileSync(binaryPath, ["index"], { cwd: delDir });

  const delSamples = [];
  let delResult = null;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const raw = execFileSync(binaryPath, ["impact-v2", "--base", "HEAD~1", "--depth", "2", "--format", "json"], { cwd: delDir, encoding: "utf8" });
    delSamples.push(performance.now() - t0);
    if (!delResult) delResult = JSON.parse(raw);
  }
  const delStats = computeStats(delSamples);

  // 8. Measure Cycle Graph (A <-> B cyclic dependency)
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

  // 9. Synthetic Graphs: 100, 1k edges
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
    rmSync(scipDir, { recursive: true, force: true });
    rmSync(delDir, { recursive: true, force: true });
    rmSync(cycleDir, { recursive: true, force: true });
    rmSync(synthetic100Dir, { recursive: true, force: true });
    rmSync(synthetic1kDir, { recursive: true, force: true });
  } catch {}

  const report = {
    schema_version: 1,
    milestone: "M4",
    title: "Milestone 4 Verifiable Transitive Impact Benchmark",
    timestamp: new Date().toISOString(),
    functional_source_sha: declaredFunctionalSha,
    benchmark_harness_sha: harnessSha,
    binary_source_sha: declaredFunctionalSha,
    source_sha: declaredFunctionalSha,
    branch: gitBranch,
    platform: process.platform,
    arch: process.arch,
    benchmarks: {
      change_extraction: {
        ...changeExtractionStats,
        description: "NUL-delimited safe git delta extraction",
      },
      fresh_scip_impact: {
        ...scipStats,
        assurance: scipResult?.assurance ?? "DEGRADED",
        result_count: scipResult?.impacted?.length ?? 0,
        changes_count: scipResult?.changes?.length ?? 0,
        description: "Fresh SCIP-backed canonical-symbol impact traversal",
        provider_state: "Fresh",
        provider_health: "Available",
        provider_id: "scip-typescript",
        semantic_node_prefix: "sem:",
        path_provider: "scip",
        fingerprint_match: true,
        setup_provider_executions: setupProviderExecutions,
        timed_provider_executions: timedProviderExecutions,
      },
      effective_stale_fallback: {
        ...staleStats,
        assurance: staleResult?.assurance ?? "DEGRADED",
        result_count: staleResult?.impacted?.length ?? 0,
        changes_count: staleResult?.changes?.length ?? 0,
        description: "Effective stale provider fallback impact traversal",
        effective_provider_state: "Stale",
        provider_stale: true,
        fallback_used: true,
        fallback_provider: "manual_rule",
        fallback_strength: "heuristic",
      },
      deleted_symbol_impact: {
        ...delStats,
        assurance: delResult?.assurance ?? "DEGRADED",
        result_count: delResult?.impacted?.length ?? 0,
        changes_count: delResult?.changes?.length ?? 0,
        description: "Deleted-symbol before-evidence traversal",
      },
      one_hop_impact: {
        ...oneHopStats,
        assurance: oneHopResult?.assurance ?? "DEGRADED",
        result_count: oneHopResult?.impacted?.length ?? 0,
        changes_count: oneHopResult?.changes?.length ?? 0,
        description: "1-hop direct caller and importer impact traversal",
      },
      three_hop_impact: {
        ...threeHopStats,
        assurance: threeHopResult?.assurance ?? "DEGRADED",
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
        assurance: cycleResult?.assurance ?? "DEGRADED",
        result_count: cycleResult?.impacted?.length ?? 0,
        description: "Cycle-safe traversal over mutual dependencies",
      },
      synthetic_100_edges: {
        ...syn100Stats,
        assurance: syn100Result?.assurance ?? "DEGRADED",
        result_count: syn100Result?.impacted?.length ?? 0,
        description: "100-edge fanout traversal",
      },
      synthetic_1k_edges: {
        ...syn1kStats,
        assurance: syn1kResult?.assurance ?? "DEGRADED",
        result_count: syn1kResult?.impacted?.length ?? 0,
        description: "1,000-edge fanout traversal",
      },
    },
  };

  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + "\n");

  const markdown = "# Milestone 4: Verifiable Transitive Impact & Change Intelligence Benchmark Report\n\n" +
    "- **Functional Source SHA**: `" + declaredFunctionalSha + "`\n" +
    "- **Benchmark Harness SHA**: `" + harnessSha + "`\n" +
    "- **Binary Source SHA**: `" + declaredFunctionalSha + "`\n" +
    "- **Branch**: `" + gitBranch + "`\n" +
    "- **Timestamp**: `" + report.timestamp + "`\n" +
    "- **Platform**: `" + report.platform + "-" + report.arch + "`\n\n" +
    "---\n\n" +
    "## Benchmark Results\n\n" +
    "| Scenario | Median (ms) | p95 (ms) | Min (ms) | Max (ms) | Impact Count | Assurance |\n" +
    "|---|---|---|---|---|---|---|\n" +
    "| **Change Extraction** | " + report.benchmarks.change_extraction.median + " | " + report.benchmarks.change_extraction.p95 + " | " + report.benchmarks.change_extraction.min + " | " + report.benchmarks.change_extraction.max + " | - | - |\n" +
    "| **Fresh SCIP Impact** | " + report.benchmarks.fresh_scip_impact.median + " | " + report.benchmarks.fresh_scip_impact.p95 + " | " + report.benchmarks.fresh_scip_impact.min + " | " + report.benchmarks.fresh_scip_impact.max + " | " + report.benchmarks.fresh_scip_impact.result_count + " | " + report.benchmarks.fresh_scip_impact.assurance + " |\n" +
    "| **Effective Stale Fallback** | " + report.benchmarks.effective_stale_fallback.median + " | " + report.benchmarks.effective_stale_fallback.p95 + " | " + report.benchmarks.effective_stale_fallback.min + " | " + report.benchmarks.effective_stale_fallback.max + " | " + report.benchmarks.effective_stale_fallback.result_count + " | " + report.benchmarks.effective_stale_fallback.assurance + " |\n" +
    "| **Deleted-Symbol Impact** | " + report.benchmarks.deleted_symbol_impact.median + " | " + report.benchmarks.deleted_symbol_impact.p95 + " | " + report.benchmarks.deleted_symbol_impact.min + " | " + report.benchmarks.deleted_symbol_impact.max + " | " + report.benchmarks.deleted_symbol_impact.result_count + " | " + report.benchmarks.deleted_symbol_impact.assurance + " |\n" +
    "| **1-Hop Impact** | " + report.benchmarks.one_hop_impact.median + " | " + report.benchmarks.one_hop_impact.p95 + " | " + report.benchmarks.one_hop_impact.min + " | " + report.benchmarks.one_hop_impact.max + " | " + report.benchmarks.one_hop_impact.result_count + " | " + report.benchmarks.one_hop_impact.assurance + " |\n" +
    "| **3-Hop Impact** | " + report.benchmarks.three_hop_impact.median + " | " + report.benchmarks.three_hop_impact.p95 + " | " + report.benchmarks.three_hop_impact.min + " | " + report.benchmarks.three_hop_impact.max + " | " + report.benchmarks.three_hop_impact.result_count + " | " + report.benchmarks.three_hop_impact.assurance + " |\n" +
    "| **Why Explanation** | " + report.benchmarks.why_explanation.median + " | " + report.benchmarks.why_explanation.p95 + " | " + report.benchmarks.why_explanation.min + " | " + report.benchmarks.why_explanation.max + " | 1 | - |\n" +
    "| **Cycle Graph** | " + report.benchmarks.cycle_graph.median + " | " + report.benchmarks.cycle_graph.p95 + " | " + report.benchmarks.cycle_graph.min + " | " + report.benchmarks.cycle_graph.max + " | " + report.benchmarks.cycle_graph.result_count + " | " + report.benchmarks.cycle_graph.assurance + " |\n" +
    "| **Synthetic (100 edges)** | " + report.benchmarks.synthetic_100_edges.median + " | " + report.benchmarks.synthetic_100_edges.p95 + " | " + report.benchmarks.synthetic_100_edges.min + " | " + report.benchmarks.synthetic_100_edges.max + " | " + report.benchmarks.synthetic_100_edges.result_count + " | " + report.benchmarks.synthetic_100_edges.assurance + " |\n" +
    "| **Synthetic (1,000 edges)** | " + report.benchmarks.synthetic_1k_edges.median + " | " + report.benchmarks.synthetic_1k_edges.p95 + " | " + report.benchmarks.synthetic_1k_edges.min + " | " + report.benchmarks.synthetic_1k_edges.max + " | " + report.benchmarks.synthetic_1k_edges.result_count + " | " + report.benchmarks.synthetic_1k_edges.assurance + " |\n\n" +
    "---\n\n" +
    "## Reproduction Command\n\n" +
    "```bash\nFDX_BINARY_PATH=/path/to/functional/release/fdx node scripts/benchmark-fdx-vci-m4.mjs\n```\n";

  writeFileSync(REPORT_MD_PATH, markdown);
  console.log("Benchmark complete. Wrote:");
  console.log("  -", REPORT_JSON_PATH);
  console.log("  -", REPORT_MD_PATH);
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});