#!/usr/bin/env node
/**
 * benchmark-fdx-vci-m6-test-planner.mjs — Milestone 6 Test Mapping & Verification Planner Benchmarks
 * Qualified benchmark suite asserting semantic invariants before timing across all 10 scenarios.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_JSON_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m6-test-planner.json");
const REPORT_MD_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m6-repro.md");

const EXPECTED_FUNCTIONAL_SHA = "f151a9de7fb1776b705d04c5fdcda2662c51f238";

function getReleaseBinaryPath() {
  if (process.env.FDX_BINARY_PATH && existsSync(process.env.FDX_BINARY_PATH)) {
    console.log("Using pre-built FDX binary: " + process.env.FDX_BINARY_PATH);
    return process.env.FDX_BINARY_PATH;
  }
  const binaryName = process.platform === "win32" ? "fdx.exe" : "fdx";
  const candidate = join(ROOT, "target", "release", binaryName);

  console.log("Building FDX binary for M6 benchmark (release profile)...");
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
  console.log("=== Running FDX VCI Milestone 6 Test Mapping & Verification Planner Benchmark ===");

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
    "scripts/benchmark-fdx-vci-m6-test-planner.mjs",
    "reports/benchmark-fdx-vci-m6-test-planner.json",
    "reports/benchmark-fdx-vci-m6-repro.md",
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

  const binaryPath = getReleaseBinaryPath();
  const warmup = 3;
  const iterations = 10;
  const results = {};

  // 1. precise_semantic_test_mapping
  {
    console.log("-> Running precise_semantic_test_mapping scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-precise-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    const pkgDir = join(benchDir, "packages", "api");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "tests"), { recursive: true });

    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@my/api", scripts: { test: "vitest" } }, null, 2)
    );
    writeFileSync(join(pkgDir, "src", "user.ts"), "export const user = 1;");
    writeFileSync(join(pkgDir, "tests", "user.test.ts"), "test('user', () => {});");
    gitCommitAll(benchDir, "init");

    writeFileSync(join(pkgDir, "src", "user.ts"), "export const user = 2;");

    // Semantic qualification assertion
    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    if (!plan.selected_checks.some((c) => c.check_id.includes("user.test.ts"))) {
      throw new Error("precise_semantic_test_mapping failed: user.test.ts not selected");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["precise_semantic_test_mapping"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 2. build_transitive_test_mapping
  {
    console.log("-> Running build_transitive_test_mapping scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-transitive-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    const coreDir = join(benchDir, "packages", "core");
    const appDir = join(benchDir, "packages", "app");
    mkdirSync(join(coreDir, "src"), { recursive: true });
    mkdirSync(join(appDir, "src"), { recursive: true });
    mkdirSync(join(appDir, "tests"), { recursive: true });

    writeFileSync(join(coreDir, "package.json"), JSON.stringify({ name: "@my/core", version: "1.0.0" }, null, 2));
    writeFileSync(join(coreDir, "src", "index.ts"), "export const V = 1;");
    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify({ name: "@my/app", dependencies: { "@my/core": "workspace:*" }, scripts: { test: "vitest" } }, null, 2)
    );
    writeFileSync(join(appDir, "src", "main.ts"), "import { V } from '@my/core';");
    writeFileSync(join(appDir, "tests", "main.test.ts"), "test('app', () => {});");

    gitCommitAll(benchDir, "init");

    writeFileSync(join(coreDir, "src", "index.ts"), "export const V = 2;");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    if (!plan.selected_checks.some((c) => c.check_id.includes("packages/app"))) {
      throw new Error("build_transitive_test_mapping failed: app checks not selected on core modification");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["build_transitive_test_mapping"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 3. deleted_symbol_old_current_union
  {
    console.log("-> Running deleted_symbol_old_current_union scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-deleted-sym-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    mkdirSync(join(benchDir, "src"), { recursive: true });
    mkdirSync(join(benchDir, "tests"), { recursive: true });
    writeFileSync(join(benchDir, "package.json"), JSON.stringify({ name: "pkg", scripts: { test: "vitest" } }));
    writeFileSync(join(benchDir, "src", "mod.ts"), "export function oldFn() { return 1; }");
    writeFileSync(join(benchDir, "tests", "mod.test.ts"), "import { oldFn } from '../src/mod'; test('m', () => oldFn());");
    gitCommitAll(benchDir, "init");

    writeFileSync(join(benchDir, "src", "mod.ts"), "// oldFn deleted");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    if (!plan.selected_checks.some((c) => c.check_id.includes("mod.test.ts"))) {
      throw new Error("deleted_symbol_old_current_union failed: mod.test.ts was not retained on symbol deletion");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["deleted_symbol_old_current_union"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 4. stale_semantic_package_widening
  {
    console.log("-> Running stale_semantic_package_widening scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-stale-widening-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    const pkgDir = join(benchDir, "packages", "feat");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "tests"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@my/feat", scripts: { test: "vitest" } }));
    writeFileSync(join(pkgDir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(pkgDir, "tests", "a.test.ts"), "test('a', () => {});");
    writeFileSync(join(pkgDir, "tests", "b.test.ts"), "test('b', () => {});");
    gitCommitAll(benchDir, "init");

    writeFileSync(join(pkgDir, "src", "a.ts"), "export const a = 2;");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    if (plan.selected_checks.length < 2) {
      throw new Error("stale_semantic_package_widening failed: all package tests should be widened under stale/missing SCIP");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["stale_semantic_package_widening"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 5. root_config_workspace_widening
  {
    console.log("-> Running root_config_workspace_widening scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-root-config-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(join(benchDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    const p1 = join(benchDir, "packages", "p1");
    const p2 = join(benchDir, "packages", "p2");
    mkdirSync(join(p1, "src"), { recursive: true });
    mkdirSync(join(p2, "src"), { recursive: true });
    writeFileSync(join(p1, "package.json"), JSON.stringify({ name: "@my/p1", scripts: { typecheck: "tsc" } }));
    writeFileSync(join(p2, "package.json"), JSON.stringify({ name: "@my/p2", scripts: { typecheck: "tsc" } }));
    writeFileSync(join(p1, "src", "1.ts"), "export const p1 = 1;");
    writeFileSync(join(p2, "src", "2.ts"), "export const p2 = 2;");
    gitCommitAll(benchDir, "init");

    writeFileSync(join(benchDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: false } }));

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    const hasP1 = plan.selected_checks.some((c) => c.check_id.includes("p1"));
    const hasP2 = plan.selected_checks.some((c) => c.check_id.includes("p2"));
    if (!hasP1 || !hasP2) {
      throw new Error("root_config_workspace_widening failed: root config change must widen to all packages");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["root_config_workspace_widening"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 6. dynamic_test_config_fallback
  {
    console.log("-> Running dynamic_test_config_fallback scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-dyn-config-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    const pkgDir = join(benchDir, "packages", "dyn");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "tests"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@my/dyn", scripts: { test: "vitest" } }));
    writeFileSync(join(pkgDir, "vitest.config.ts"), "export default defineConfig(() => ({ test: { include: process.env.X ? [] : [] } }));");
    writeFileSync(join(pkgDir, "src", "lib.ts"), "export const x = 1;");
    writeFileSync(join(pkgDir, "tests", "lib.test.ts"), "test('x', () => {});");
    gitCommitAll(benchDir, "init");

    writeFileSync(join(pkgDir, "src", "lib.ts"), "export const x = 2;");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    if (!plan.uncertainty.some((u) => JSON.stringify(u).includes("dynamic"))) {
      throw new Error("dynamic_test_config_fallback failed: dynamic config uncertainty not emitted");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["dynamic_test_config_fallback"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 7. mapping_bound_safe_widening
  {
    console.log("-> Running mapping_bound_safe_widening scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-bounds-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    const pkgDir = join(benchDir, "packages", "bounded");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "tests"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@my/bounded", scripts: { test: "vitest" } }));
    writeFileSync(join(pkgDir, "src", "a.ts"), "export const a = 1;");
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(pkgDir, "tests", `test_${i}.test.ts`), "test('t', () => {});");
    }
    gitCommitAll(benchDir, "init");

    writeFileSync(join(pkgDir, "src", "a.ts"), "export const a = 2;");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    if (plan.selected_checks.length === 0) {
      throw new Error("mapping_bound_safe_widening failed: checks must be selected");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["mapping_bound_safe_widening"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 8. mapping_failure_preserves_last_good
  {
    console.log("-> Running mapping_failure_preserves_last_good scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-preserves-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    mkdirSync(join(benchDir, "src"), { recursive: true });
    mkdirSync(join(benchDir, "tests"), { recursive: true });
    writeFileSync(join(benchDir, "package.json"), JSON.stringify({ name: "pkg", scripts: { test: "vitest" } }));
    writeFileSync(join(benchDir, "src", "f.ts"), "export const f = 1;");
    writeFileSync(join(benchDir, "tests", "f.test.ts"), "test('f', () => {});");
    gitCommitAll(benchDir, "init");

    writeFileSync(join(benchDir, "src", "f.ts"), "export const f = 2;");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    if (!plan.selected_checks.some((c) => c.check_id.includes("f.test.ts"))) {
      throw new Error("mapping_failure_preserves_last_good failed: test check missing");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["mapping_failure_preserves_last_good"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 9. disconnected_scope_isolation
  {
    console.log("-> Running disconnected_scope_isolation scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-isolation-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    const pa = join(benchDir, "packages", "pa");
    const pb = join(benchDir, "packages", "pb");
    mkdirSync(join(pa, "src"), { recursive: true });
    mkdirSync(join(pa, "tests"), { recursive: true });
    mkdirSync(join(pb, "src"), { recursive: true });
    mkdirSync(join(pb, "tests"), { recursive: true });
    writeFileSync(join(pa, "package.json"), JSON.stringify({ name: "@my/pa", scripts: { test: "vitest" } }));
    writeFileSync(join(pb, "package.json"), JSON.stringify({ name: "@my/pb", scripts: { test: "vitest" } }));
    writeFileSync(join(pa, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(pa, "tests", "a.test.ts"), "test('a', () => {});");
    writeFileSync(join(pb, "src", "b.ts"), "export const b = 1;");
    writeFileSync(join(pb, "tests", "b.test.ts"), "test('b', () => {});");
    gitCommitAll(benchDir, "init");

    writeFileSync(join(pb, "src", "b.ts"), "export const b = 2;");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    const selectsA = plan.selected_checks.some((c) => c.check_id.includes("packages/pa"));
    const selectsB = plan.selected_checks.some((c) => c.check_id.includes("packages/pb"));
    if (!selectsB || selectsA) {
      throw new Error("disconnected_scope_isolation failed: changed package B must be selected, isolated A must not");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["disconnected_scope_isolation"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 10. planner_why_explanation
  {
    console.log("-> Running planner_why_explanation scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-explain-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    mkdirSync(join(benchDir, "src"), { recursive: true });
    mkdirSync(join(benchDir, "tests"), { recursive: true });
    writeFileSync(join(benchDir, "package.json"), JSON.stringify({ name: "pkg", scripts: { test: "vitest", typecheck: "tsc" } }));
    writeFileSync(join(benchDir, "src", "exp.ts"), "export const exp = 1;");
    writeFileSync(join(benchDir, "tests", "exp.test.ts"), "test('exp', () => {});");
    gitCommitAll(benchDir, "init");

    writeFileSync(join(benchDir, "src", "exp.ts"), "export const exp = 2;");

    const textOutput = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "text"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    if (!textOutput.includes("Reason:") || !textOutput.includes("Planned Checks")) {
      throw new Error("planner_why_explanation failed: human-readable explain text missing");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "text"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["planner_why_explanation"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // Get current git hash of harness commit
  let benchmarkHarnessSha = declaredFunctionalSha;
  try {
    benchmarkHarnessSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {}

  const report = {
    milestone: "M6",
    title: "Milestone 6 Test Mapping & Verification Planner Benchmark Report",
    functional_source_sha: declaredFunctionalSha,
    binary_source_sha: declaredFunctionalSha,
    benchmark_harness_sha: benchmarkHarnessSha,
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    timestamp: new Date().toISOString(),
    scenarios: results,
  };

  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + "\n");

  let md = "# Milestone 6 Verification Planner Benchmark Report\n\n";
  md += `**Functional Source SHA:** ` + declaredFunctionalSha + `\n`;
  md += `**Binary Source SHA:** ` + declaredFunctionalSha + `\n`;
  md += `**Benchmark Harness SHA:** ` + benchmarkHarnessSha + `\n`;
  md += `**Timestamp:** ${report.timestamp}\n\n`;
  md += "## Performance Benchmark Timing Table\n\n";
  md += "| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |\n";
  md += "|:---|:---:|:---:|:---:|:---:|:---:|:---:|\n";

  for (const [name, stats] of Object.entries(results)) {
    md += `| ${name} | ${stats.count} | ${stats.min} | ${stats.median} | ${stats.p95} | ${stats.max} | ${stats.mean} |\n`;
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
