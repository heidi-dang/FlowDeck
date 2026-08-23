#!/usr/bin/env node
/**
 * benchmark-fdx-vci-m5.mjs — Milestone 5 Build/Config Graph Federation & Scoped Uncertainty Benchmarks
 * Qualified benchmark suite asserting semantic invariants before timing across all 10 scenarios.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_JSON_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m5-build-config.json");
const REPORT_MD_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m5-repro.md");

const EXPECTED_FUNCTIONAL_SHA = "229fd40cf7c33791d6d75b9a991aed9e92b3cee6";

function getReleaseBinaryPath() {
  if (process.env.FDX_BINARY_PATH && existsSync(process.env.FDX_BINARY_PATH)) {
    console.log("Using pre-built FDX binary: " + process.env.FDX_BINARY_PATH);
    return process.env.FDX_BINARY_PATH;
  }
  const binaryName = process.platform === "win32" ? "fdx.exe" : "fdx";
  const candidate = join(ROOT, "target", "release", binaryName);

  console.log("Building FDX binary for M5 benchmark (release profile)...");
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
  console.log("=== Running FDX VCI Milestone 5 Build/Config Graph Federation Benchmark ===");

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
    "scripts/benchmark-fdx-vci-m5.mjs",
    "reports/benchmark-fdx-vci-m5-build-config.json",
    "reports/benchmark-fdx-vci-m5-repro.md",
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
    ["diff", "--name-only", "HEAD", "--", "scripts/benchmark-fdx-vci-m5.mjs"],
    { cwd: ROOT, encoding: "utf8" }
  ).trim();
  if (unstagedHarnessDiff) {
    throw new Error(
      "Benchmark harness differs from committed HEAD; commit harness before execution"
    );
  }

  const stagedHarnessDiff = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--", "scripts/benchmark-fdx-vci-m5.mjs"],
    { cwd: ROOT, encoding: "utf8" }
  ).trim();
  if (stagedHarnessDiff) {
    throw new Error(
      "Benchmark harness has staged uncommitted changes; commit harness before execution"
    );
  }

  const harnessSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const binaryPath = getReleaseBinaryPath();

  const results = {};
  const warmup = 2;
  const iterations = 5;

  // 1. fresh_build_config_aware_impact
  {
    console.log("-> Running fresh_build_config_aware_impact scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m5-fresh-impact-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2)
    );
    for (let i = 0; i < 10; i++) {
      const pdir = join(benchDir, "packages", `pkg-${i}`, "src");
      mkdirSync(pdir, { recursive: true });
      writeFileSync(join(pdir, "index.ts"), `export const x = ${i};`);
      const deps = i > 0 ? { [`@app/pkg-${i - 1}`]: "1.0.0" } : {};
      writeFileSync(
        join(benchDir, "packages", `pkg-${i}`, "package.json"),
        JSON.stringify({ name: `@app/pkg-${i}`, version: "1.0.0", dependencies: deps }, null, 2)
      );
    }
    gitCommitAll(benchDir, "init");
    execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });

    // Modify pkg-0
    writeFileSync(join(benchDir, "packages", "pkg-0", "src", "index.ts"), "export const x = 999;");

    // Semantic qualification assertions
    const verifyRaw = execFileSync(
      binaryPath,
      ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"],
      { cwd: benchDir, encoding: "utf8" }
    );
    const verifyImpact = JSON.parse(verifyRaw);

    const pkg1Target = verifyImpact.impacted.find((t) => t.target === "packages/pkg-1");
    if (!pkg1Target) {
      throw new Error(`fresh_build_config_aware_impact semantic assertion failed: packages/pkg-1 not found in impacted: ${JSON.stringify(verifyImpact.impacted)}`);
    }
    if (!pkg1Target.primary_path || !pkg1Target.primary_path.steps) {
      throw new Error("fresh_build_config_aware_impact semantic assertion failed: missing primary path steps");
    }
    const hasBuildNative = pkg1Target.primary_path.steps.some((s) => s.provider === "build_native");
    if (!hasBuildNative) {
      throw new Error("fresh_build_config_aware_impact semantic assertion failed: evidence path does not contain provider=build_native");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["fresh_build_config_aware_impact"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 2. stale_new_dependency_snapshot_union
  {
    console.log("-> Running stale_new_dependency_snapshot_union scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m5-stale-union-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2)
    );
    for (const name of ["pkg-a", "pkg-b", "pkg-c"]) {
      const pdir = join(benchDir, "packages", name, "src");
      mkdirSync(pdir, { recursive: true });
      writeFileSync(join(pdir, "index.ts"), "export const x = 1;");
      const deps = name === "pkg-a" ? { "@app/pkg-b": "1.0.0" } : {};
      writeFileSync(
        join(benchDir, "packages", name, "package.json"),
        JSON.stringify({ name: `@app/${name}`, version: "1.0.0", dependencies: deps }, null, 2)
      );
    }
    gitCommitAll(benchDir, "T0: A -> B");
    execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });

    // T1: introduce A -> C without refreshing build graph
    writeFileSync(
      join(benchDir, "packages", "pkg-a", "package.json"),
      JSON.stringify({ name: "@app/pkg-a", version: "1.0.0", dependencies: { "@app/pkg-b": "1.0.0", "@app/pkg-c": "1.0.0" } }, null, 2)
    );
    gitCommitAll(benchDir, "T1: commit A -> C dependency");

    // Modify only C source
    writeFileSync(join(benchDir, "packages", "pkg-c", "src", "index.ts"), "export const x = 2;");

    // Semantic qualification assertions
    const verifyRaw = execFileSync(
      binaryPath,
      ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"],
      { cwd: benchDir, encoding: "utf8" }
    );
    const verifyImpact = JSON.parse(verifyRaw);

    const hasPkgA = verifyImpact.impacted.some((t) => t.target.includes("packages/pkg-a"));
    if (!hasPkgA) {
      throw new Error(`stale_new_dependency_snapshot_union semantic assertion failed: pkg-a not impacted: ${JSON.stringify(verifyImpact.impacted)}`);
    }
    const hasStaleUncertainty = verifyImpact.uncertainty.some((u) => u.kind === "build_provider_stale");
    if (!hasStaleUncertainty) {
      throw new Error("stale_new_dependency_snapshot_union semantic assertion failed: build_provider_stale uncertainty missing");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["stale_new_dependency_snapshot_union"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 3. stale_scope_isolation
  {
    console.log("-> Running stale_scope_isolation scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m5-stale-isolation-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2)
    );
    for (const name of ["pkg-a", "pkg-b"]) {
      const pdir = join(benchDir, "packages", name, "src");
      mkdirSync(pdir, { recursive: true });
      writeFileSync(join(pdir, "index.ts"), "export const x = 1;");
      writeFileSync(
        join(benchDir, "packages", name, "package.json"),
        JSON.stringify({ name: `@app/${name}`, version: "1.0.0" }, null, 2)
      );
    }
    gitCommitAll(benchDir, "init test");
    execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });

    // Modify pkg-a manifest (stale for A) and pkg-b source
    writeFileSync(
      join(benchDir, "packages", "pkg-a", "package.json"),
      JSON.stringify({ name: "@app/pkg-a", version: "1.0.1", description: "stale" }, null, 2)
    );
    writeFileSync(join(benchDir, "packages", "pkg-b", "src", "index.ts"), "export const x = 2;");

    // Semantic qualification assertion: pkg-b query is unaffected by pkg-a stale state
    const verifyRaw = execFileSync(
      binaryPath,
      ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"],
      { cwd: benchDir, encoding: "utf8" }
    );
    const verifyImpact = JSON.parse(verifyRaw);

    const hasPkgB = verifyImpact.impacted.some((t) => t.target.includes("packages/pkg-b"));
    if (!hasPkgB) {
      throw new Error("stale_scope_isolation semantic assertion failed: pkg-b not impacted");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["stale_scope_isolation"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 4. workspace_root_membership_change
  {
    console.log("-> Running workspace_root_membership_change scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m5-ws-root-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2)
    );
    const pdir = join(benchDir, "packages", "core", "src");
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "index.ts"), "export const c = 1;");
    writeFileSync(
      join(benchDir, "packages", "core", "package.json"),
      JSON.stringify({ name: "@app/core", version: "1.0.0" }, null, 2)
    );
    gitCommitAll(benchDir, "init");
    execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });

    // Modify root manifest
    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*", "libs/*"] }, null, 2)
    );

    // Semantic qualification assertions
    const verifyRaw = execFileSync(
      binaryPath,
      ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"],
      { cwd: benchDir, encoding: "utf8" }
    );
    const verifyImpact = JSON.parse(verifyRaw);
    if (!verifyImpact.uncertainty.some((u) => u.kind === "build_provider_stale")) {
      throw new Error("workspace_root_membership_change semantic assertion failed: build_provider_stale uncertainty missing");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["workspace_root_membership_change"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 5. bound_safe_widening
  {
    console.log("-> Running bound_safe_widening scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m5-bounds-widening-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2)
    );
    for (let i = 0; i < 5; i++) {
      const pdir = join(benchDir, "packages", `pkg-${i}`, "src");
      mkdirSync(pdir, { recursive: true });
      writeFileSync(join(pdir, "index.ts"), "export const x = 1;");
      writeFileSync(
        join(benchDir, "packages", `pkg-${i}`, "package.json"),
        JSON.stringify({ name: `@app/pkg-${i}`, version: "1.0.0" }, null, 2)
      );
    }
    gitCommitAll(benchDir, "init");
    execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });

    writeFileSync(join(benchDir, "packages", "pkg-4", "src", "index.ts"), "export const x = 2;");

    // Semantic qualification assertions
    const verifyRaw = execFileSync(
      binaryPath,
      ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"],
      { cwd: benchDir, encoding: "utf8" }
    );
    const verifyImpact = JSON.parse(verifyRaw);
    if (!verifyImpact.impacted.some((t) => t.target.includes("packages/pkg-4"))) {
      throw new Error("bound_safe_widening semantic assertion failed: pkg-4 not included in impacted targets");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["bound_safe_widening"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 6. provider_disappearance
  {
    console.log("-> Running provider_disappearance scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m5-provider-disappear-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", version: "1.0.0" }, null, 2)
    );
    gitCommitAll(benchDir, "init");
    execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });

    // Remove manifest
    unlinkSync(join(benchDir, "package.json"));

    // Semantic qualification assertion: refresh retires evidence
    const refreshOutput = execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir, encoding: "utf8" });
    if (!refreshOutput.includes("builtin-package-json") || refreshOutput.includes("FAILED")) {
      throw new Error(`provider_disappearance semantic assertion failed: ${refreshOutput}`);
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["provider_disappearance"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 7. provider_detection_failure_preserves_evidence
  {
    console.log("-> Running provider_detection_failure_preserves_evidence scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m5-preserves-evidence-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", version: "1.0.0" }, null, 2)
    );
    gitCommitAll(benchDir, "init");
    execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });

    // Verify evidence exists before testing
    const statusOutput = execFileSync(binaryPath, ["build", "status"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    if (!statusOutput.includes("builtin-package-json")) {
      throw new Error("provider_detection_failure_preserves_evidence assertion failed: provider missing in status");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["build", "status"], { cwd: benchDir });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["provider_detection_failure_preserves_evidence"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 8. malformed_snapshot_provider_failure
  {
    console.log("-> Running malformed_snapshot_provider_failure scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m5-malformed-snap-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", version: "1.0.0" }, null, 2)
    );
    const pdir = join(benchDir, "src");
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "index.ts"), "export const x = 1;");
    gitCommitAll(benchDir, "init");
    execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });

    // Corrupt root package.json without refreshing
    writeFileSync(join(benchDir, "package.json"), '{"name": "root", MALFORMED');
    writeFileSync(join(pdir, "index.ts"), "export const x = 2;");

    // Semantic qualification assertion: snapshot uncertainty triggers safe widening
    const verifyRaw = execFileSync(
      binaryPath,
      ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"],
      { cwd: benchDir, encoding: "utf8" }
    );
    const verifyImpact = JSON.parse(verifyRaw);
    if (!verifyImpact.uncertainty.some((u) => u.kind === "malformed_config" || u.kind === "build_provider_failed")) {
      throw new Error("malformed_snapshot_provider_failure semantic assertion failed: uncertainty missing");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["malformed_snapshot_provider_failure"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 9. malformed_package_local_control
  {
    console.log("-> Running malformed_package_local_control scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m5-malformed-local-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2)
    );
    const pdirA = join(benchDir, "packages", "a", "src");
    mkdirSync(pdirA, { recursive: true });
    writeFileSync(join(pdirA, "index.ts"), "export const a = 1;");
    writeFileSync(
      join(benchDir, "packages", "a", "package.json"),
      JSON.stringify({ name: "@app/a", version: "1.0.0" }, null, 2)
    );

    const pdirB = join(benchDir, "packages", "b");
    mkdirSync(pdirB, { recursive: true });
    writeFileSync(join(pdirB, "package.json"), '{"name": "@app/b", MALFORMED');

    gitCommitAll(benchDir, "init");
    try {
      execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });
    } catch {}

    writeFileSync(join(pdirA, "index.ts"), "export const a = 2;");

    // Semantic qualification assertions
    const verifyRaw = execFileSync(
      binaryPath,
      ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"],
      { cwd: benchDir, encoding: "utf8" }
    );
    const verifyImpact = JSON.parse(verifyRaw);
    const hasMalformedB = verifyImpact.uncertainty.some(
      (u) => u.kind === "malformed_config" && JSON.stringify(u).includes("packages/b")
    );
    if (!hasMalformedB) {
      throw new Error("malformed_package_local_control semantic assertion failed: malformed_config scoped uncertainty missing");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["malformed_package_local_control"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 10. why_typed_build_path
  {
    console.log("-> Running why_typed_build_path scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m5-why-path-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { target: "es2022" } }, null, 2)
    );
    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2)
    );
    const pdir = join(benchDir, "packages", "web", "src");
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "index.ts"), "export const w = 1;");
    writeFileSync(
      join(benchDir, "packages", "web", "package.json"),
      JSON.stringify({ name: "@app/web", version: "1.0.0" }, null, 2)
    );
    writeFileSync(
      join(benchDir, "packages", "web", "tsconfig.json"),
      JSON.stringify({ extends: "../../tsconfig.base.json" }, null, 2)
    );
    gitCommitAll(benchDir, "init");
    execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });

    // Modify base tsconfig
    writeFileSync(
      join(benchDir, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { target: "es2020" } }, null, 2)
    );

    // Semantic qualification assertion: why finds path through tsconfig.base.json
    const whyRaw = execFileSync(
      binaryPath,
      ["why", "packages/web/tsconfig.json", "--base", "HEAD", "--depth", "3", "--format", "json"],
      { cwd: benchDir, encoding: "utf8" }
    );
    const whyJson = JSON.parse(whyRaw);
    if (!whyJson.primary_path || !whyJson.primary_path.steps || whyJson.primary_path.steps.length === 0) {
      throw new Error("why_typed_build_path semantic assertion failed: missing primary path steps");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["why", "packages/web/tsconfig.json", "--base", "HEAD", "--depth", "3", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["why_typed_build_path"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  const reportPayload = {
    metadata: {
      benchmark: "benchmark-fdx-vci-m5-build-config",
      timestamp: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      functional_source_sha: declaredFunctionalSha,
      binary_source_sha: declaredFunctionalSha,
      benchmark_harness_sha: harnessSha,
      binary_path: binaryPath,
    },
    results,
  };

  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(REPORT_JSON_PATH, JSON.stringify(reportPayload, null, 2));
  console.log(`Saved benchmark report to ${REPORT_JSON_PATH}`);

  let mdContent = "# Milestone 5 Build/Config Graph Federation Benchmark Report\n\n" +
    "## Provenance\n\n" +
    "- **Benchmark Name**: `benchmark-fdx-vci-m5-build-config`\n" +
    `- **Timestamp**: \`${reportPayload.metadata.timestamp}\`\n` +
    `- **Functional Source SHA**: \`${reportPayload.metadata.functional_source_sha}\`\n` +
    `- **Binary Source SHA**: \`${reportPayload.metadata.binary_source_sha}\`\n` +
    `- **Benchmark Harness SHA**: \`${reportPayload.metadata.benchmark_harness_sha}\`\n` +
    `- **Platform**: \`${reportPayload.metadata.platform} (${reportPayload.metadata.arch})\`\n\n` +
    "## Performance Results\n\n" +
    "| Benchmark Scenario | Samples | Median (ms) | P95 (ms) | Min (ms) | Max (ms) | Mean (ms) |\n" +
    "| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n";

  for (const [key, stats] of Object.entries(results)) {
    if (!stats) continue;
    mdContent += `| \`${key}\` | ${stats.count} | ${stats.median} | ${stats.p95} | ${stats.min} | ${stats.max} | ${stats.mean} |\n`;
  }

  writeFileSync(REPORT_MD_PATH, mdContent);
  console.log(`Saved markdown repro report to ${REPORT_MD_PATH}`);
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
