#!/usr/bin/env node
/**
 * benchmark-fdx-vci-m6-test-planner.mjs — Milestone 6 Test Mapping & Verification Planner Benchmarks
 * Hardened H10 benchmark suite asserting complete semantic invariants before timing across all 10 scenarios.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_JSON_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m6-test-planner.json");
const REPORT_MD_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m6-repro.md");

const EXPECTED_FUNCTIONAL_SHA = "95a0f143fdc4bdb573f401fd063be9ba55004935";

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

function initFdxDb(dir, _binaryPath) {
  const fdxDir = join(dir, ".fdx");
  mkdirSync(fdxDir, { recursive: true });
  const dbPath = join(fdxDir, "index.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA user_version = 5;
    CREATE TABLE IF NOT EXISTS schema_metadata (version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO schema_metadata (version) VALUES (5);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (
      canonical_path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER,
      language TEXT,
      indexed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nodes (
      stable_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      canonical_path TEXT,
      symbol_identity TEXT,
      package_identity TEXT,
      metadata TEXT,
      provider TEXT,
      provider_fingerprint TEXT,
      generation INTEGER,
      source_hash TEXT,
      stale BOOLEAN NOT NULL DEFAULT 0,
      source_identity TEXT
    );
    CREATE TABLE IF NOT EXISTS edges (
      stable_id TEXT PRIMARY KEY,
      from_node TEXT NOT NULL,
      to_node TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_fingerprint TEXT NOT NULL,
      strength INTEGER NOT NULL,
      source_identity TEXT,
      source_hash TEXT,
      created_revision INTEGER NOT NULL,
      updated_revision INTEGER NOT NULL,
      stale BOOLEAN NOT NULL DEFAULT 0,
      generation INTEGER,
      metadata TEXT,
      provider_id TEXT
    );
    CREATE TABLE IF NOT EXISTS provider_state (
      provider TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      compatibility_data TEXT
    );
    CREATE TABLE IF NOT EXISTS semantic_providers (
      provider_id TEXT PRIMARY KEY,
      provider_type TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      executable_identity TEXT NOT NULL,
      scip_schema_version TEXT NOT NULL,
      languages TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      package TEXT,
      config_fingerprint TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      last_successful_run INTEGER,
      health TEXT NOT NULL,
      freshness TEXT NOT NULL,
      output_digest TEXT,
      failure_reason TEXT,
      semantic_generation INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

async function runBenchmark() {
  console.log("=== Running FDX VCI Milestone 6 Test Mapping & Verification Planner Benchmark (H10) ===");

  const declaredFunctionalSha = process.env.FDX_BENCHMARK_FUNCTIONAL_SHA || EXPECTED_FUNCTIONAL_SHA;
  if (declaredFunctionalSha !== EXPECTED_FUNCTIONAL_SHA) {
    throw new Error(
      `Declared functional SHA ${declaredFunctionalSha} does not match expected functional SHA ${EXPECTED_FUNCTIONAL_SHA}`
    );
  }

  // Strict working-tree and staged diff checks on harness file
  try {
    execFileSync("git", ["diff", "--quiet", "--", "scripts/benchmark-fdx-vci-m6-test-planner.mjs"], { cwd: ROOT });
  } catch {
    throw new Error("Harness working-tree diff must be empty before benchmark run.");
  }
  try {
    execFileSync("git", ["diff", "--cached", "--quiet", "--", "scripts/benchmark-fdx-vci-m6-test-planner.mjs"], { cwd: ROOT });
  } catch {
    throw new Error("Harness staged diff must be empty before benchmark run.");
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

  // 1. precise_semantic_test_mapping (persisted precise SCIP evidence fixture)
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
      JSON.stringify({ name: "@my/api", scripts: { test: "vitest", typecheck: "tsc" } }, null, 2)
    );
    writeFileSync(join(pkgDir, "src", "user.ts"), "export function createUser() { return 1; }\nexport function deleteUser() { return 2; }\n");
    writeFileSync(join(pkgDir, "tests", "user.test.ts"), "test('user', () => {});");
    writeFileSync(join(pkgDir, "tests", "unrelated.test.ts"), "test('unrelated', () => {});");

    const mockBin = join(benchDir, "mock-scip-ts");
    writeFileSync(mockBin, "#!/bin/sh\nexit 0\n");
    chmodSync(mockBin, 0o755);

    gitCommitAll(benchDir, "init");

    // Ingest build graph
    execFileSync(binaryPath, ["build", "refresh"], {
      cwd: benchDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBin },
      stdio: "ignore",
    });

    // Seed precise SCIP reference edge in SQLite
    const db = initFdxDb(benchDir, binaryPath);
    db.exec(`
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/tests/user.test.ts', 'hash_test', 50, 100);
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/src/user.ts', 'hash_src', 50, 100);
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/api/tests/user.test.ts', 'file', 'packages/api/tests/user.test.ts', 'pkg:npm:packages/api');
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/api/src/user.ts:createUser', 'symbol', 'packages/api/src/user.ts', 'createUser', 'pkg:npm:packages/api');
      INSERT OR REPLACE INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:user_test_refs_createUser', 'file:packages/api/tests/user.test.ts', 'sym:packages/api/src/user.ts:createUser', 'references', 'scip_ts', 'fp_scip_m6', 4, 'packages/api/tests/user.test.ts', 'hash_test', 1, 1, 0, 'scip-typescript');
    `);
    db.close();

    writeFileSync(join(pkgDir, "src", "user.ts"), "export function createUser() { return 42; }\nexport function deleteUser() { return 2; }\n");

    // Semantic qualification assertions
    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBin },
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    const userTest = plan.selected_checks.find((c) => c.check_id.includes("user.test.ts"));
    if (!userTest) {
      throw new Error("precise_semantic_test_mapping failed: user.test.ts not selected");
    }
    if (userTest.selection !== "evidence") {
      throw new Error("precise_semantic_test_mapping failed: user.test.ts selection is not evidence");
    }
    if (userTest.strength !== "precise") {
      throw new Error("precise_semantic_test_mapping failed: user.test.ts strength is not precise");
    }
    if (!userTest.evidence_path) {
      throw new Error("precise_semantic_test_mapping failed: user.test.ts missing evidence_path");
    }
    if (!userTest.evidence_refs || userTest.evidence_refs.length === 0) {
      throw new Error("precise_semantic_test_mapping failed: user.test.ts missing evidence_refs");
    }
    const evRef = userTest.evidence_refs[0];
    if (evRef.provider_id !== "scip-typescript" || evRef.provider_fingerprint !== "fp_scip_m6") {
      throw new Error("precise_semantic_test_mapping failed: evidence_refs provider_id or fingerprint mismatch");
    }
    if (plan.selected_checks.some((c) => c.check_id.includes("unrelated.test.ts"))) {
      throw new Error("precise_semantic_test_mapping failed: unrelated.test.ts must NOT be selected under precise SCIP");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: benchDir,
        env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBin },
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["precise_semantic_test_mapping"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }
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

  // 3. deleted_symbol_old_current_union (persisted before-state mapping preserved on symbol deletion)
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

    // Persist real before-state mapping in DB
    const db = initFdxDb(benchDir, binaryPath);
    db.exec(`
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('tests/mod.test.ts', 'h1', 50, 100);
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('src/mod.ts', 'h2', 50, 100);
      INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:tests/mod.test.ts', 'file', 'tests/mod.test.ts', 'pkg:npm:.');
      INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:src/mod.ts:oldFn', 'symbol', 'src/mod.ts', 'oldFn', 'pkg:npm:.');
      INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:mod_test_refs_oldFn', 'file:tests/mod.test.ts', 'sym:src/mod.ts:oldFn', 'references', 'scip_ts', 'fp_old_union', 4, 'tests/mod.test.ts', 'h1', 1, 1, 0, 'scip-typescript');
    `);
    db.close();

    // Delete symbol in src/mod.ts
    writeFileSync(join(benchDir, "src", "mod.ts"), "// oldFn deleted");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    const modTest = plan.selected_checks.find((c) => c.check_id.includes("mod.test.ts"));
    if (!modTest) {
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

  // 4. stale_semantic_package_widening (persisted stale SCIP evidence fixture)
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

    // Persist stale edge (stale = 1)
    const db = initFdxDb(benchDir, binaryPath);
    db.exec(`
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/feat/tests/a.test.ts', 'h1', 50, 100);
      INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/feat/tests/a.test.ts', 'file', 'packages/feat/tests/a.test.ts', 'pkg:npm:packages/feat');
      INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/feat/src/a.ts:a', 'symbol', 'packages/feat/src/a.ts', 'a', 'pkg:npm:packages/feat');
      INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:a_stale_edge', 'file:packages/feat/tests/a.test.ts', 'sym:packages/feat/src/a.ts:a', 'references', 'scip_ts', 'fp_stale', 4, 'packages/feat/tests/a.test.ts', 'h1', 1, 1, 1, 'scip-typescript');
    `);
    db.close();

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

  // 7. selected_check_bound_safe_rollup (crosses production max_selected_checks = 2000 bound with safe rollup)
  {
    console.log("-> Running selected_check_bound_safe_rollup scenario (>2000 checks bound crossing)...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-bounds-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    const pkgDir = join(benchDir, "packages", "bounded");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "tests"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@my/bounded", scripts: { test: "vitest" } }));
    writeFileSync(join(pkgDir, "src", "a.ts"), "export const a = 1;");

    // Generate 2100 test files crossing max_selected_checks = 2000
    for (let i = 0; i < 2100; i++) {
      writeFileSync(join(pkgDir, "tests", `test_${i}.test.ts`), "test('t', () => {});");
    }
    gitCommitAll(benchDir, "init");

    writeFileSync(join(pkgDir, "src", "a.ts"), "export const a = 2;");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);

    // Assert safe rollup to package suite check under output bound
    const hasRollupCheck = plan.selected_checks.some((c) => c.check_id === "check:pkg:npm:packages/bounded:test");
    if (!hasRollupCheck) {
      throw new Error("selected_check_bound_safe_rollup failed: package suite rollup check missing when >2000 tests selected");
    }
    if (plan.selected_checks.length > 2000) {
      throw new Error("selected_check_bound_safe_rollup failed: selected_checks length must be <= 2000");
    }
    if (!plan.uncertainty.some((u) => JSON.stringify(u).toLowerCase().includes("limit"))) {
      throw new Error("selected_check_bound_safe_rollup failed: limit uncertainty must be emitted on output bound rollup");
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
    results["selected_check_bound_safe_rollup"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 8. mapping_failure_widens_safely (induces mapping query failure and verifies safe fail-closed package widening)
  {
    console.log("-> Running mapping_failure_widens_safely scenario...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-mapping-fail-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    const pkgDir = join(benchDir, "packages", "failpkg");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "tests"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@my/failpkg", scripts: { test: "vitest" } }));
    writeFileSync(join(pkgDir, "src", "f.ts"), "export const f = 1;");
    writeFileSync(join(pkgDir, "tests", "f.test.ts"), "test('f', () => {});");
    gitCommitAll(benchDir, "init");

    // Initialize DB and alter edges schema to induce mapping query failure
    const db = initFdxDb(benchDir, binaryPath);
    db.exec("DROP TABLE IF EXISTS edges; CREATE TABLE edges (corrupted_column INTEGER);");
    db.close();

    writeFileSync(join(pkgDir, "src", "f.ts"), "export const f = 2;");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    if (!plan.uncertainty.some((u) => JSON.stringify(u).includes("GraphCorrupt") || JSON.stringify(u).includes("mapping"))) {
      throw new Error("mapping_failure_widens_safely failed: GraphCorrupt / mapping error uncertainty not emitted");
    }
    if (plan.selected_checks.length === 0) {
      throw new Error("mapping_failure_widens_safely failed: mapping failure must widen safely to package checks");
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
    results["mapping_failure_widens_safely"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 9. disconnected_scope_isolation (verified against clean control repo)
  {
    console.log("-> Running disconnected_scope_isolation scenario (control vs test isolation)...");
    const controlDir = join(tmpdir(), `fdx-bench-m6-control-${Date.now()}`);
    const testDir = join(tmpdir(), `fdx-bench-m6-isolation-${Date.now()}`);
    mkdirSync(controlDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    initGitRepo(controlDir);
    initGitRepo(testDir);

    // Control: only package B
    const controlPb = join(controlDir, "packages", "pb");
    mkdirSync(join(controlPb, "src"), { recursive: true });
    mkdirSync(join(controlPb, "tests"), { recursive: true });
    writeFileSync(join(controlPb, "package.json"), JSON.stringify({ name: "@my/pb", scripts: { test: "vitest" } }));
    writeFileSync(join(controlPb, "src", "b.ts"), "export const b = 1;");
    writeFileSync(join(controlPb, "tests", "b.test.ts"), "test('b', () => {});");
    gitCommitAll(controlDir, "init");
    writeFileSync(join(controlPb, "src", "b.ts"), "export const b = 2;");

    // Test: package A + package B (only B modified)
    const pa = join(testDir, "packages", "pa");
    const pb = join(testDir, "packages", "pb");
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
    gitCommitAll(testDir, "init");
    writeFileSync(join(pb, "src", "b.ts"), "export const b = 2;");

    const controlPlanRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: controlDir,
      encoding: "utf8",
    });
    const testPlanRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: testDir,
      encoding: "utf8",
    });
    const controlPlan = JSON.parse(controlPlanRaw);
    const testPlan = JSON.parse(testPlanRaw);

    const selectsA = testPlan.selected_checks.some((c) => c.check_id.includes("packages/pa"));
    const selectsB = testPlan.selected_checks.some((c) => c.check_id.includes("packages/pb"));
    if (!selectsB || selectsA) {
      throw new Error("disconnected_scope_isolation failed: changed package B must be selected, isolated A must not");
    }
    if (testPlan.assurance !== controlPlan.assurance) {
      throw new Error("disconnected_scope_isolation failed: isolated package presence must not alter assurance");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: testDir,
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["disconnected_scope_isolation"] = computeStats(samples);
    rmSync(controlDir, { recursive: true, force: true });
    rmSync(testDir, { recursive: true, force: true });
  }

  // 10. planner_why_explanation (asserts JSON evidence contracts and text output)
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

    const jsonOutput = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      encoding: "utf8",
    });
    const plan = JSON.parse(jsonOutput);

    // Assert JSON semantic contracts for every selected check
    for (const check of plan.selected_checks) {
      if (check.selection === "evidence") {
        if (!check.evidence_path || !check.evidence_refs || check.evidence_refs.length === 0) {
          throw new Error(`planner_why_explanation contract failed on ${check.check_id}: evidence check must have evidence_path and non-empty evidence_refs`);
        }
      } else if (check.selection === "policy_widening") {
        if (!check.widening_reason) {
          throw new Error(`planner_why_explanation contract failed on ${check.check_id}: policy_widening check must have widening_reason`);
        }
      } else if (check.selection === "mandatory_check") {
        if (!check.mandatory || !check.reason) {
          throw new Error(`planner_why_explanation contract failed on ${check.check_id}: mandatory_check must have mandatory=true and named reason`);
        }
      }
    }

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
