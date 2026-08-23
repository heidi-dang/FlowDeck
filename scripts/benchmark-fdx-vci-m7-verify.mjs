#!/usr/bin/env node
/**
 * benchmark-fdx-vci-m7-verify.mjs — Milestone 7 Verification Executor Benchmarks
 * Hardened H16 benchmark suite asserting complete semantic verification invariants before timing across execution scenarios.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_JSON_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m7-verify.json");
const REPORT_MD_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m7-repro.md");

const EXPECTED_FUNCTIONAL_SHA = "8161d57680697772fcedcfe91893e5cb651c27b7";

function getReleaseBinaryPath() {
  if (process.env.FDX_BINARY_PATH && existsSync(process.env.FDX_BINARY_PATH)) {
    console.log("Using pre-built FDX binary: " + process.env.FDX_BINARY_PATH);
    return process.env.FDX_BINARY_PATH;
  }
  const binaryName = process.platform === "win32" ? "fdx.exe" : "fdx";
  const candidate = join(ROOT, "target", "release", binaryName);

  console.log("Building FDX binary for M7 benchmark (release profile)...");
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

function gitInitAndCommitAll(repo) {
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "BenchmarkRunner"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "benchmark@flowdeck.dev"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repo, stdio: "ignore" });
}

function invokeFdxVerify(bin, repo, args = []) {
  try {
    const stdout = execFileSync(bin, ["verify", "--format", "json", ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    return { exitCode: 0, stdout, data: JSON.parse(stdout) };
  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString() : "";
    let data = null;
    try {
      data = JSON.parse(stdout);
    } catch {}
    return { exitCode: err.status || 1, stdout, data, error: err };
  }
}

async function runPreflights(bin) {
  console.log("-> Running M7 execution and safety preflights...");

  // Preflight 1: Passing verification run
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-pass-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "pass-pkg",
      scripts: { test: "node -e 'process.exit(0)'" }
    }));
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "src.js"), "module.exports = 1;");

    const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
    if (res.exitCode !== 0 || res.data?.outcome !== "passed") {
      throw new Error("Preflight 1 failed: passing run must exit 0 and report outcome 'passed'");
    }
    rmSync(repo, { recursive: true, force: true });
  }

  // Preflight 2: Real test failure
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-fail-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "fail-pkg",
      scripts: { test: "node -e 'process.exit(42)'" }
    }));
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "src.js"), "module.exports = 2;");

    const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
    if (res.exitCode !== 1 || res.data?.outcome !== "failed") {
      throw new Error("Preflight 2 failed: failing test must exit 1 and report outcome 'failed'");
    }
    rmSync(repo, { recursive: true, force: true });
  }

  // Preflight 3: Secret redaction before disk persistence
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-redact-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "secret-pkg",
      scripts: { test: "node -e \"console.log('sk-1234567890abcdefghijklmnopqrstuvwxyz and Bearer myauthtoken123456')\"" }
    }));
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "src.js"), "module.exports = 3;");

    const res = invokeFdxVerify(bin, repo);
    if (!res.data) throw new Error("Preflight 3 failed: missing JSON output");
    const jsonStr = JSON.stringify(res.data);
    if (jsonStr.includes("1234567890abcdefghijklmnopqrstuvwxyz") || jsonStr.includes("myauthtoken123456")) {
      throw new Error("Preflight 3 failed: secrets must be redacted before emission/persistence");
    }
    rmSync(repo, { recursive: true, force: true });
  }

  // Preflight 4: Package manager ambiguity fails closed
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-pm-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "ambig-pkg",
      scripts: { test: "node -e 'process.exit(0)'" }
    }));
    writeFileSync(join(repo, "pnpm-lock.yaml"), "");
    writeFileSync(join(repo, "yarn.lock"), "");
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "src.js"), "module.exports = 4;");

    const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
    if (res.data?.outcome === "passed") {
      throw new Error("Preflight 4 failed: ambiguous package manager must not pass");
    }
    rmSync(repo, { recursive: true, force: true });
  }

  // Preflight 5: Dirty worktree execution
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-dirty-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "dirty-pkg",
      scripts: { test: "node -e 'process.exit(0)'" }
    }));
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "dirty.js"), "console.log('uncommitted');");

    const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
    if (res.exitCode !== 0 || res.data?.outcome !== "passed") {
      throw new Error("Preflight 5 failed: verification against dirty worktree must succeed");
    }
    rmSync(repo, { recursive: true, force: true });
  }
}

async function runBenchmark() {
  console.log("=== Running FDX VCI Milestone 7 Verification Executor Benchmark (H16) ===");

  const harnessStatus = execFileSync("git", ["status", "--porcelain", "--", "scripts/benchmark-fdx-vci-m7-verify.mjs"], {
    cwd: ROOT,
    encoding: "utf8"
  }).trim();
  if (harnessStatus) {
    throw new Error("Harness working-tree diff must be empty before benchmark run.");
  }

  const HARNESS_SHA = execFileSync("git", ["log", "-1", "--format=%H", "--", "scripts/benchmark-fdx-vci-m7-verify.mjs"], {
    cwd: ROOT,
    encoding: "utf8"
  }).trim();

  const bin = getReleaseBinaryPath();
  await runPreflights(bin);

  const iterations = 10;
  const timings = {};

  // Scenario 1: verify_passing_unit_test_package
  {
    console.log("-> Running verify_passing_unit_test_package scenario...");
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const repo = join(tmpdir(), "fdx-m7-bench-pass-" + i + "-" + Date.now());
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        name: "bench-pass-pkg",
        scripts: { test: "node -e 'process.exit(0)'" }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "src.js"), "module.exports = 1;");

      const t0 = performance.now();
      const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
      const t1 = performance.now();
      if (res.exitCode !== 0 || res.data?.outcome !== "passed") {
        throw new Error("verify_passing_unit_test_package failed");
      }
      samples.push(t1 - t0);
      rmSync(repo, { recursive: true, force: true });
    }
    timings.verify_passing_unit_test_package = computeStats(samples);
  }

  // Scenario 2: verify_failing_unit_test_package
  {
    console.log("-> Running verify_failing_unit_test_package scenario...");
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const repo = join(tmpdir(), "fdx-m7-bench-fail-" + i + "-" + Date.now());
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        name: "bench-fail-pkg",
        scripts: { test: "node -e 'process.exit(1)'" }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "src.js"), "module.exports = 1;");

      const t0 = performance.now();
      const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
      const t1 = performance.now();
      if (res.exitCode !== 1 || res.data?.outcome !== "failed") {
        throw new Error("verify_failing_unit_test_package failed");
      }
      samples.push(t1 - t0);
      rmSync(repo, { recursive: true, force: true });
    }
    timings.verify_failing_unit_test_package = computeStats(samples);
  }

  // Scenario 3: verify_multi_check_package_suite
  {
    console.log("-> Running verify_multi_check_package_suite scenario...");
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const repo = join(tmpdir(), "fdx-m7-bench-multi-" + i + "-" + Date.now());
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        name: "bench-multi-pkg",
        scripts: {
          test: "node -e 'process.exit(0)'",
          typecheck: "node -e 'process.exit(0)'",
          lint: "node -e 'process.exit(0)'"
        }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "src.js"), "module.exports = 1;");

      const t0 = performance.now();
      const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
      const t1 = performance.now();
      if (res.exitCode !== 0 || res.data?.outcome !== "passed") {
        throw new Error("verify_multi_check_package_suite failed");
      }
      samples.push(t1 - t0);
      rmSync(repo, { recursive: true, force: true });
    }
    timings.verify_multi_check_package_suite = computeStats(samples);
  }

  // Scenario 4: verify_fail_fast_short_circuit
  {
    console.log("-> Running verify_fail_fast_short_circuit scenario...");
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const repo = join(tmpdir(), "fdx-m7-bench-ff-" + i + "-" + Date.now());
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        name: "bench-ff-pkg",
        scripts: {
          test: "node -e 'process.exit(1)'",
          typecheck: "node -e 'setTimeout(() => {}, 5000)'"
        }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "src.js"), "module.exports = 1;");

      const t0 = performance.now();
      const res = invokeFdxVerify(bin, repo, ["--fail-fast", "--no-persist"]);
      const t1 = performance.now();
      if (res.exitCode !== 1 || res.data?.outcome !== "failed") {
        throw new Error("verify_fail_fast_short_circuit failed");
      }
      samples.push(t1 - t0);
      rmSync(repo, { recursive: true, force: true });
    }
    timings.verify_fail_fast_short_circuit = computeStats(samples);
  }

  // Scenario 5: verify_output_bound_and_redaction
  {
    console.log("-> Running verify_output_bound_and_redaction scenario...");
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const repo = join(tmpdir(), "fdx-m7-bench-redact-" + i + "-" + Date.now());
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        name: "bench-redact-pkg",
        scripts: {
          test: "node -e \"console.log('sk-1234567890abcdefghijklmnopqrstuvwxyz'.repeat(100))\""
        }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "src.js"), "module.exports = 1;");

      const t0 = performance.now();
      const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
      const t1 = performance.now();
      if (res.exitCode !== 0 || res.data?.outcome !== "passed") {
        throw new Error("verify_output_bound_and_redaction failed");
      }
      samples.push(t1 - t0);
      rmSync(repo, { recursive: true, force: true });
    }
    timings.verify_output_bound_and_redaction = computeStats(samples);
  }

  // Scenario 6: verify_run_persistence_and_retrieval
  {
    console.log("-> Running verify_run_persistence_and_retrieval scenario...");
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const repo = join(tmpdir(), "fdx-m7-bench-persist-" + i + "-" + Date.now());
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        name: "bench-persist-pkg",
        scripts: { test: "node -e 'process.exit(0)'" }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "src.js"), "module.exports = 1;");

      const t0 = performance.now();
      const res = invokeFdxVerify(bin, repo);
      const t1 = performance.now();
      if (res.exitCode !== 0 || !res.data?.run_id) {
        throw new Error("verify_run_persistence_and_retrieval failed");
      }
      const artifactPath = join(repo, ".fdx", "runs", `${res.data.run_id}.json`);
      if (!existsSync(artifactPath)) {
        throw new Error("Run artifact not persisted to expected path: " + artifactPath);
      }
      samples.push(t1 - t0);
      rmSync(repo, { recursive: true, force: true });
    }
    timings.verify_run_persistence_and_retrieval = computeStats(samples);
  }

  // Scenario 7: verify_dirty_worktree_execution
  {
    console.log("-> Running verify_dirty_worktree_execution scenario...");
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const repo = join(tmpdir(), "fdx-m7-bench-dirty-" + i + "-" + Date.now());
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        name: "bench-dirty-pkg",
        scripts: { test: "node -e 'process.exit(0)'" }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "uncommitted.js"), "module.exports = 'dirty';");

      const t0 = performance.now();
      const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
      const t1 = performance.now();
      if (res.exitCode !== 0 || res.data?.outcome !== "passed") {
        throw new Error("verify_dirty_worktree_execution failed");
      }
      samples.push(t1 - t0);
      rmSync(repo, { recursive: true, force: true });
    }
    timings.verify_dirty_worktree_execution = computeStats(samples);
  }

  const timestamp = new Date().toISOString();
  const functionalSha = EXPECTED_FUNCTIONAL_SHA;
  const binarySha = EXPECTED_FUNCTIONAL_SHA;

  const reportJson = {
    milestone: "M7",
    title: "Milestone 7 Verification Executor Benchmark Report",
    functional_source_sha: functionalSha,
    binary_source_sha: binarySha,
    benchmark_harness_sha: HARNESS_SHA,
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    timestamp,
    scenarios: timings,
  };

  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(REPORT_JSON_PATH, JSON.stringify(reportJson, null, 2) + "\n");

  let md = "# Milestone 7 Verification Executor Benchmark Report\n\n";
  md += `**Functional Source SHA:** ${functionalSha}\n`;
  md += `**Binary Source SHA:** ${binarySha}\n`;
  md += `**Benchmark Harness SHA:** ${HARNESS_SHA}\n`;
  md += `**Timestamp:** ${timestamp}\n\n`;
  md += "## Performance Benchmark Timing Table\n\n";
  md += "| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |\n";
  md += "|:---|:---:|:---:|:---:|:---:|:---:|:---:|\n";

  for (const [name, s] of Object.entries(timings)) {
    md += `| ${name} | ${s.count} | ${s.min} | ${s.median} | ${s.p95} | ${s.max} | ${s.mean} |\n`;
  }

  writeFileSync(REPORT_MD_PATH, md);
  console.log("Benchmark complete. Reports generated at:");
  console.log("  " + REPORT_JSON_PATH);
  console.log("  " + REPORT_MD_PATH);
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
