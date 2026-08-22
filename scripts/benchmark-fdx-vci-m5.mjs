#!/usr/bin/env node
/**
 * benchmark-fdx-vci-m5.mjs — Milestone 5 Build/Config Graph Federation & Scoped Uncertainty Benchmarks
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_JSON_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m5-build-config.json");
const REPORT_MD_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m5-repro.md");

const EXPECTED_FUNCTIONAL_SHA = "0f5e3ed9d94509d3539ffbf84a7507ec1fdb60bd";

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

  // 1. package.json workspace discovery & discovery bounds qualification
  {
    const benchDir = join(tmpdir(), `fdx-bench-m5-pkg-discover-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2)
    );
    for (let i = 0; i < 20; i++) {
      const pdir = join(benchDir, "packages", `pkg-${i}`);
      mkdirSync(pdir, { recursive: true });
      writeFileSync(
        join(pdir, "package.json"),
        JSON.stringify({ name: `@app/pkg-${i}`, version: "1.0.0", scripts: { build: "tsc" } }, null, 2)
      );
    }
    gitCommitAll(benchDir, "init");

    // Semantic qualification before timing
    const refreshOutput = execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir, encoding: "utf8" });
    if (!refreshOutput.includes("builtin-package-json ok") || refreshOutput.includes("FAILED")) {
      throw new Error(`Discovery semantic qualification failed: ${refreshOutput}`);
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["package_json_workspace_discovery"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 2. 100-package workspace graph
  {
    const benchDir = join(tmpdir(), `fdx-bench-m5-100pkg-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2)
    );
    for (let i = 0; i < 100; i++) {
      const pdir = join(benchDir, "packages", `pkg-${i}`);
      mkdirSync(pdir, { recursive: true });
      const deps = i > 0 ? { [`@app/pkg-${i - 1}`]: "1.0.0" } : {};
      writeFileSync(
        join(pdir, "package.json"),
        JSON.stringify({ name: `@app/pkg-${i}`, version: "1.0.0", dependencies: deps }, null, 2)
      );
    }
    gitCommitAll(benchDir, "init");

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["100_package_workspace_graph"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 3. 1,000 package dependency edges
  {
    const benchDir = join(tmpdir(), `fdx-bench-m5-1000edges-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2)
    );
    const numPkgs = 50;
    for (let i = 0; i < numPkgs; i++) {
      const pdir = join(benchDir, "packages", `pkg-${i}`);
      mkdirSync(pdir, { recursive: true });
      const deps = {};
      for (let j = 0; j < numPkgs; j++) {
        if (i !== j && (i + j) % 2 === 0) {
          deps[`@app/pkg-${j}`] = "1.0.0";
        }
      }
      writeFileSync(
        join(pdir, "package.json"),
        JSON.stringify({ name: `@app/pkg-${i}`, version: "1.0.0", dependencies: deps }, null, 2)
      );
    }
    gitCommitAll(benchDir, "init");

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["1000_package_dependency_edges"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 4. tsconfig extends chain
  {
    const benchDir = join(tmpdir(), `fdx-bench-m5-tsconfig-extends-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    for (let i = 0; i < 30; i++) {
      const next = i === 29 ? "" : `"extends": "./tsconfig.${i + 1}.json",`;
      writeFileSync(
        join(benchDir, `tsconfig.${i}.json`),
        `{ ${next} "compilerOptions": { "target": "es2022" } }`
      );
    }
    gitCommitAll(benchDir, "init");

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["tsconfig_extends_chain"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 5. tsconfig reference fanout
  {
    const benchDir = join(tmpdir(), `fdx-bench-m5-tsconfig-refs-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    const refs = [];
    for (let i = 1; i <= 30; i++) {
      const pdir = join(benchDir, "packages", `pkg-${i}`);
      mkdirSync(pdir, { recursive: true });
      writeFileSync(
        join(pdir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { composite: true } }, null, 2)
      );
      refs.push({ path: `./packages/pkg-${i}` });
    }
    writeFileSync(
      join(benchDir, "tsconfig.json"),
      JSON.stringify({ files: [], references: refs }, null, 2)
    );
    gitCommitAll(benchDir, "init");

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["tsconfig_reference_fanout"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 6. Cargo workspace discovery
  {
    const benchDir = join(tmpdir(), `fdx-bench-m5-cargo-discover-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "Cargo.toml"),
      `[workspace]\nmembers = [\n  "crates/*",\n]\n`
    );
    for (let i = 0; i < 20; i++) {
      const cdir = join(benchDir, "crates", `crate_${i}`, "src");
      mkdirSync(cdir, { recursive: true });
      writeFileSync(join(cdir, "lib.rs"), "pub fn run() {}");
      writeFileSync(
        join(benchDir, "crates", `crate_${i}`, "Cargo.toml"),
        `[package]\nname = "crate_${i}"\nversion = "0.1.0"\nedition = "2021"\n`
      );
    }
    gitCommitAll(benchDir, "init");

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["cargo_workspace_discovery"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 7. Cargo path-dependency fanout
  {
    const benchDir = join(tmpdir(), `fdx-bench-m5-cargo-deps-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "Cargo.toml"),
      `[workspace]\nmembers = [\n  "crates/core",\n  "crates/cli_*",\n]\n`
    );
    const coreDir = join(benchDir, "crates", "core", "src");
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(join(coreDir, "lib.rs"), "pub fn base() {}");
    writeFileSync(
      join(benchDir, "crates", "core", "Cargo.toml"),
      `[package]\nname = "core"\nversion = "0.1.0"\nedition = "2021"\n`
    );

    for (let i = 0; i < 20; i++) {
      const cdir = join(benchDir, "crates", `cli_${i}`, "src");
      mkdirSync(cdir, { recursive: true });
      writeFileSync(join(cdir, "main.rs"), "fn main() {}");
      writeFileSync(
        join(benchDir, "crates", `cli_${i}`, "Cargo.toml"),
        `[package]\nname = "cli_${i}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ncore = { path = "../core" }\n`
      );
    }
    gitCommitAll(benchDir, "init");

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["cargo_path_dependency_fanout"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 8. fresh build/config-aware impact (with semantic assertions)
  {
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

    // Assert: source file mapped to owning package pkg-0 and dependent package pkg-1 appears
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

  // 9. stale scoped config widening (with semantic assertions)
  {
    const benchDir = join(tmpdir(), `fdx-bench-m5-stale-widening-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2)
    );
    const pdir = join(benchDir, "packages", "web", "src");
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "index.ts"), "export const a = 1;");
    writeFileSync(
      join(benchDir, "packages", "web", "package.json"),
      JSON.stringify({ name: "@app/web", version: "1.0.0" }, null, 2)
    );
    gitCommitAll(benchDir, "init");
    execFileSync(binaryPath, ["build", "refresh"], { cwd: benchDir });

    // Modify package.json without refreshing (creates Stale provider state)
    writeFileSync(
      join(benchDir, "packages", "web", "package.json"),
      JSON.stringify({ name: "@app/web", version: "1.0.1" }, null, 2)
    );

    // Semantic qualification assertions
    const verifyRaw = execFileSync(
      binaryPath,
      ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"],
      { cwd: benchDir, encoding: "utf8" }
    );
    const verifyImpact = JSON.parse(verifyRaw);
    const hasStaleUncertainty = verifyImpact.uncertainty.some((u) => u.kind === "build_provider_stale");
    if (!hasStaleUncertainty) {
      throw new Error("stale_scoped_config_widening semantic assertion failed: build_provider_stale uncertainty missing");
    }
    if (verifyImpact.assurance === "exact") {
      throw new Error("stale_scoped_config_widening semantic assertion failed: assurance was exact despite stale provider");
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
    results["stale_scoped_config_widening"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 10. malformed package-local config (with non-degradation semantic assertions)
  {
    const benchDir = join(tmpdir(), `fdx-bench-m5-malformed-pkg-${Date.now()}`);
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

    // Semantic qualification assertion: malformed pkg-b uncertainty is present as scoped diagnostic
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
      throw new Error("malformed_package_local_config semantic assertion failed: malformed_config scoped uncertainty missing");
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
    results["malformed_package_local_config"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 11. workspace-root uncertainty
  {
    const benchDir = join(tmpdir(), `fdx-bench-m5-ws-root-unc-${Date.now()}`);
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

    // Modify root workspace manifest
    writeFileSync(
      join(benchDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*", "libs/*"] }, null, 2)
    );

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["impact-v2", "--base", "HEAD", "--depth", "3", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["workspace_root_uncertainty"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 12. why explanation through config/package/build path
  {
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

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["why", "packages/web/tsconfig.json", "--base", "HEAD", "--depth", "3", "--format", "json"], {
        cwd: benchDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["why_explanation_through_build_path"] = computeStats(samples);
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
