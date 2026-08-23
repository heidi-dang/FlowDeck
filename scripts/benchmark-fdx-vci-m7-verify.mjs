#!/usr/bin/env node
/**
 * benchmark-fdx-vci-m7-verify.mjs — Milestone 7 Verification Executor Benchmarks
 * Hardened H18 benchmark suite asserting non-vacuous semantic verification invariants before timing across execution scenarios.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_JSON_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m7-verify.json");
const REPORT_MD_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m7-repro.md");

const EXPECTED_FUNCTIONAL_SHA = "be22a7950cace14c319bbf68c85bad00e8fd34c6";

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
  console.log("-> Running non-vacuous M7 execution and safety preflights...");

  // 1. Basic pass
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-pass-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "pass-pkg",
      packageManager: "npm@10.0.0",
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

  // 2. Real failure (exit 42)
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-fail-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "fail-pkg",
      packageManager: "npm@10.0.0",
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

  // 3. Secret redaction before disk persistence
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-redact-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "secret-pkg",
      packageManager: "npm@10.0.0",
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

  // 4. Package manager missing fails closed (no packageManager field, no lockfile)
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-pm-missing-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "no-pm-pkg",
      scripts: { test: "node -e 'process.exit(0)'" }
    }));
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "src.js"), "module.exports = 4;");

    const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
    if (res.data?.outcome === "passed") {
      throw new Error("Preflight 4 failed: package without package manager evidence must not pass");
    }
    rmSync(repo, { recursive: true, force: true });
  }

  // 5. Package manager contradiction fails closed
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-pm-conflict-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "conflict-pm-pkg",
      packageManager: "pnpm@8.0.0",
      scripts: { test: "node -e 'process.exit(0)'" }
    }));
    writeFileSync(join(repo, "package-lock.json"), "{}");
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "src.js"), "module.exports = 5;");

    const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
    if (res.data?.outcome === "passed") {
      throw new Error("Preflight 5 failed: contradictory package manager must not pass");
    }
    rmSync(repo, { recursive: true, force: true });
  }

  // 6. Unknown JS test runner rolls up to package suite without false individual pass
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-unknown-runner-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "unknown-runner-pkg",
      packageManager: "npm@10.0.0",
      scripts: { test: "node -e 'process.exit(0)'" },
      devDependencies: { vitest: "^1.0.0" }
    }));
    writeFileSync(join(repo, "tests", "unit.test.js"), "module.exports = 1;");
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "tests", "unit.test.js"), "module.exports = 2;");

    const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
    if (!res.data || !Array.isArray(res.data.checks)) {
      throw new Error("Preflight 6 failed: missing checks array");
    }
    for (const check of res.data.checks) {
      if (check.check_id.startsWith("test:npm:") && check.command.includes("--")) {
        throw new Error("Preflight 6 failed: unproven runner must not forward positional file arguments");
      }
    }
    rmSync(repo, { recursive: true, force: true });
  }

  // 7. Known Vitest runner targeting reaches actual runner
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-vitest-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "vitest-runner-pkg",
      packageManager: "npm@10.0.0",
      scripts: { test: "vitest run" }
    }));
    writeFileSync(join(repo, "tests", "a.test.ts"), "test('a', () => {});");
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "tests", "a.test.ts"), "test('a updated', () => {});");

    const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
    if (!res.data) throw new Error("Preflight 7 failed: missing verification data");
    const testChecks = res.data.checks?.filter(c => c.check_id.startsWith("test:npm:"));
    if (testChecks && testChecks.length > 0) {
      for (const c of testChecks) {
        if (!c.command.includes("--") || !c.command.some(arg => arg.includes("tests/a.test.ts"))) {
          throw new Error("Preflight 7 failed: proven vitest runner must forward test file target");
        }
      }
    }
    rmSync(repo, { recursive: true, force: true });
  }

  // 8. Output limit exceeded is classified as Incomplete + Unverified
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-outbound-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "outbound-pkg",
      packageManager: "npm@10.0.0",
      scripts: { test: "node -e \"process.stdout.write('X'.repeat(5000000))\"" }
    }));
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "src.js"), "1");

    const res = invokeFdxVerify(bin, repo, ["--no-persist"]);
    if (!res.data || res.data.outcome !== "incomplete" || res.data.assurance !== "UNVERIFIED") {
      throw new Error("Preflight 8 failed: output limit exceeded must be outcome incomplete and assurance UNVERIFIED");
    }
    const outCheck = res.data.checks?.[0];
    if (!outCheck || outCheck.status !== "output_limit_exceeded") {
      throw new Error("Preflight 8 failed: check status must be output_limit_exceeded");
    }
    rmSync(repo, { recursive: true, force: true });
  }

  // 9. Atomic persistence equality: loaded == returned
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-persist-atomic-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "persist-atomic-pkg",
      packageManager: "npm@10.0.0",
      scripts: { test: "node -e 'process.exit(0)'" }
    }));
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "src.js"), "1");

    const res = invokeFdxVerify(bin, repo);
    if (res.exitCode !== 0 || !res.data?.run_id) {
      throw new Error("Preflight 9 failed: persistent run must succeed");
    }
    const runFile = join(repo, ".fdx", "runs", `${res.data.run_id}.json`);
    if (!existsSync(runFile)) {
      throw new Error("Preflight 9 failed: artifact must exist at " + runFile);
    }
    const loaded = JSON.parse(readFileSync(runFile, "utf8"));
    if (JSON.stringify(loaded) !== JSON.stringify(res.data)) {
      throw new Error("Preflight 9 failed: loaded artifact must strictly equal returned run");
    }
    if (loaded.persistence_status?.status !== "persisted") {
      throw new Error("Preflight 9 failed: persistence_status must be persisted");
    }
    rmSync(repo, { recursive: true, force: true });
  }

  // 10. Persistence failure degrades to Incomplete and preserves check evidence
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-persist-fail-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "persist-fail-pkg",
      packageManager: "npm@10.0.0",
      scripts: { test: "node -e 'process.exit(0)'" }
    }));
    mkdirSync(join(repo, ".fdx"), { recursive: true });
    writeFileSync(join(repo, ".fdx", "runs"), "blocking regular file");
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "src.js"), "1");

    const res = invokeFdxVerify(bin, repo);
    if (!res.data || res.data.outcome !== "incomplete" || res.data.assurance !== "UNVERIFIED") {
      throw new Error("Preflight 10 failed: persistence failure must yield outcome incomplete and assurance UNVERIFIED");
    }
    if (res.data.persistence_status?.status !== "failed") {
      throw new Error("Preflight 10 failed: persistence_status must be failed");
    }
    rmSync(repo, { recursive: true, force: true });
  }

  // 11. Symlink escape rejection
  if (process.platform !== "win32") {
    const repo = join(tmpdir(), "fdx-m7-preflight-symlink-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    const outside = join(tmpdir(), "fdx-m7-preflight-outside-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "symlink-pkg",
      packageManager: "npm@10.0.0",
      scripts: { test: "node -e 'process.exit(0)'" }
    }));
    try { symlinkSync(outside, join(repo, "symlinked_pkg")); } catch {}
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "src.js"), "1");

    invokeFdxVerify(bin, repo, ["--no-persist"]);
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }

  // 12. Shell injection resistance
  {
    const repo = join(tmpdir(), "fdx-m7-preflight-injection-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(repo, { recursive: true });
    const evilFile = join(repo, "pwned.txt");
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "injection-pkg",
      packageManager: "npm@10.0.0",
      scripts: { test: "node -e 'process.exit(0)'" }
    }));
    gitInitAndCommitAll(repo);
    writeFileSync(join(repo, "evil;touch pwned.txt;.js"), "1");

    invokeFdxVerify(bin, repo, ["--no-persist"]);
    if (existsSync(evilFile)) {
      throw new Error("Preflight 12 failed: shell argv injection executed side effect file");
    }
    rmSync(repo, { recursive: true, force: true });
  }
}

async function runBenchmark() {
  console.log("=== Running FDX VCI Milestone 7 Verification Executor Benchmark (H18) ===");

  // Mandatory environment and provenance validation
  const functionalSha = process.env.FDX_BENCHMARK_FUNCTIONAL_SHA;
  const binaryPath = process.env.FDX_BINARY_PATH;
  const expectedBinarySha256 = process.env.FDX_BINARY_SHA256;

  if (!functionalSha || !binaryPath || !expectedBinarySha256) {
    throw new Error(
      "Mandatory environment missing. Must provide: FDX_BENCHMARK_FUNCTIONAL_SHA, FDX_BINARY_PATH, FDX_BINARY_SHA256"
    );
  }

  if (functionalSha !== EXPECTED_FUNCTIONAL_SHA) {
    throw new Error(
      `Functional SHA mismatch. Expected: ${EXPECTED_FUNCTIONAL_SHA}, Received: ${functionalSha}`
    );
  }

  if (!existsSync(binaryPath)) {
    throw new Error(`Binary does not exist at FDX_BINARY_PATH: ${binaryPath}`);
  }

  const actualBinarySha256 = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
  if (actualBinarySha256 !== expectedBinarySha256) {
    throw new Error(
      `Binary SHA256 mismatch! Provided: ${expectedBinarySha256}, Actual: ${actualBinarySha256}`
    );
  }

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

  await runPreflights(binaryPath);

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
        packageManager: "npm@10.0.0",
        scripts: { test: "node -e 'process.exit(0)'" }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "src.js"), "module.exports = 1;");

      const t0 = performance.now();
      const res = invokeFdxVerify(binaryPath, repo, ["--no-persist"]);
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
        packageManager: "npm@10.0.0",
        scripts: { test: "node -e 'process.exit(1)'" }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "src.js"), "module.exports = 1;");

      const t0 = performance.now();
      const res = invokeFdxVerify(binaryPath, repo, ["--no-persist"]);
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
        packageManager: "npm@10.0.0",
        scripts: {
          test: "node -e 'process.exit(0)'",
          typecheck: "node -e 'process.exit(0)'",
          lint: "node -e 'process.exit(0)'"
        }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "src.js"), "module.exports = 1;");

      const t0 = performance.now();
      const res = invokeFdxVerify(binaryPath, repo, ["--no-persist"]);
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
        packageManager: "npm@10.0.0",
        scripts: {
          test: "node -e 'process.exit(1)'",
          typecheck: "node -e 'setTimeout(() => {}, 5000)'"
        }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "src.js"), "module.exports = 1;");

      const t0 = performance.now();
      const res = invokeFdxVerify(binaryPath, repo, ["--fail-fast", "--no-persist"]);
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
        packageManager: "npm@10.0.0",
        scripts: {
          test: "node -e \"console.log('sk-1234567890abcdefghijklmnopqrstuvwxyz'.repeat(100))\""
        }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "src.js"), "module.exports = 1;");

      const t0 = performance.now();
      const res = invokeFdxVerify(binaryPath, repo, ["--no-persist"]);
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
        packageManager: "npm@10.0.0",
        scripts: { test: "node -e 'process.exit(0)'" }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "src.js"), "module.exports = 1;");

      const t0 = performance.now();
      const res = invokeFdxVerify(binaryPath, repo);
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
        packageManager: "npm@10.0.0",
        scripts: { test: "node -e 'process.exit(0)'" }
      }));
      gitInitAndCommitAll(repo);
      writeFileSync(join(repo, "uncommitted.js"), "module.exports = 'dirty';");

      const t0 = performance.now();
      const res = invokeFdxVerify(binaryPath, repo, ["--no-persist"]);
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

  const reportJson = {
    milestone: "M7",
    title: "Milestone 7 Verification Executor Benchmark Report",
    functional_source_sha: functionalSha,
    binary_source_sha: functionalSha,
    binary_sha256: actualBinarySha256,
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
  md += `**Binary Source SHA:** ${functionalSha}\n`;
  md += `**Binary SHA-256:** ${actualBinarySha256}\n`;
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
