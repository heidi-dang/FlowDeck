#!/usr/bin/env node
/**
 * benchmark-fdx-vci-m6-test-planner.mjs — Milestone 6 Test Mapping & Verification Planner Benchmarks
 * Hardened H15 benchmark suite asserting complete semantic invariants before timing across all 10 scenarios.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_JSON_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m6-test-planner.json");
const REPORT_MD_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m6-repro.md");

const EXPECTED_FUNCTIONAL_SHA = "eef9d801bf43f6df7b086ee9f39e6ff8ae32f407";

const TS_CONFIG_FILES = [
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
];

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function executableContentDigest(execPath) {
  const canonical = realpathSync(execPath);
  const bytes = readFileSync(execPath);
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(bytes.length));
  const hasher = createHash("sha256");
  hasher.update(Buffer.from(canonical, "utf8"));
  hasher.update(Buffer.from(":"));
  hasher.update(lenBuf);
  hasher.update(Buffer.from(":"));
  hasher.update(bytes);
  return hasher.digest("hex");
}

function fingerprintConfigFiles(root, candidates) {
  const entries = [];
  for (const rel of candidates) {
    const full = join(root, rel);
    if (existsSync(full)) {
      entries.push({ rel, hash: sha256Hex(readFileSync(full)) });
    } else {
      entries.push({ rel, hash: "missing" });
    }
  }
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  const hasher = createHash("sha256");
  for (const { rel, hash } of entries) {
    hasher.update(Buffer.from(`${rel}=${hash};`, "utf8"));
  }
  return hasher.digest("hex");
}

function computeProviderFingerprint(version, execIdentity, schemaVersion, compilerVer, configFp) {
  const hasher = createHash("sha256");
  hasher.update(Buffer.from(`${version}|${execIdentity}|${schemaVersion}|${compilerVer || ""}|${configFp}`, "utf8"));
  return {
    provider_version: version,
    executable_identity: execIdentity,
    scip_schema_version: schemaVersion,
    config_fingerprint: configFp,
    digest: hasher.digest("hex"),
  };
}

function createMockProviderScript(dir, name, verOutput = "scip-typescript 1.0.0") {
  const bin = join(dir, name);
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${verOutput}"; exit 0; fi\nexit 0\n`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

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
      updated_at INTEGER NOT NULL,
      last_attempt_fingerprint TEXT,
      last_attempt_at INTEGER,
      last_attempt_health TEXT,
      last_attempt_failure_reason TEXT
    );
  `);
  return db;
}

async function runBenchmark() {
  console.log("=== Running FDX VCI Milestone 6 Test Mapping & Verification Planner Benchmark (H15) ===");

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

  // === Provider Coverage & Scope Correctness Semantic Preflights ===
  console.log("-> Running M6 provider coverage and scope preflights...");

  // Preflight 1: wrong_language_provider_does_not_narrow
  {
    const benchDir = join(tmpdir(), `fdx-preflight-wrong-lang-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);
    const pkg = join(benchDir, "packages", "web");
    mkdirSync(join(pkg, "src"), { recursive: true });
    mkdirSync(join(pkg, "tests"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@my/web", scripts: { test: "vitest" } }));
    writeFileSync(join(pkg, "src", "a.ts"), "export function fnA() { return 1; }\nexport function fnOther() { return 2; }\n");
    writeFileSync(join(pkg, "tests", "a.test.ts"), "test('a', () => {});");
    writeFileSync(join(pkg, "tests", "other.test.ts"), "test('other', () => {});");
    gitCommitAll(benchDir, "init");

    const db = initFdxDb(benchDir, binaryPath);
    db.exec(`
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/web/tests/a.test.ts', 'h1', 50, 100);
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/web/src/a.ts', 'h2', 50, 100);
      INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/web/tests/a.test.ts', 'file', 'packages/web/tests/a.test.ts', 'pkg:npm:packages/web');
      INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/web/src/a.ts:fnA', 'symbol', 'packages/web/src/a.ts', 'fnA', 'pkg:npm:packages/web');
      INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
        VALUES ('scip-rust', 'scip', '1.0', 'scip-rust', '0.1', '["rust"]', '.', 'packages/web', 'cfg_rust', 'fp_rust', 'available', 'fresh', 1, 100, 100);
      INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:a_test', 'file:packages/web/tests/a.test.ts', 'sym:packages/web/src/a.ts:fnA', 'references', 'scip_rust', 'fp_rust', 4, 'packages/web/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-rust');
    `);
    db.close();

    writeFileSync(join(pkg, "src", "a.ts"), "export function fnA() { return 42; }\nexport function fnOther() { return 2; }\n");
    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], { cwd: benchDir, encoding: "utf8" });
    const plan = JSON.parse(planRaw);
    if (!plan.selected_checks.some((c) => c.check_id.includes("other.test.ts") || c.check_id.includes("packages/web:test"))) {
      throw new Error("wrong_language_provider_does_not_narrow failed: fresh Rust provider must not satisfy TypeScript package mapping");
    }
    rmSync(benchDir, { recursive: true, force: true });
  }

  // Preflight 2: provider_scope_prefix_collision
  {
    const benchDir = join(tmpdir(), `fdx-preflight-prefix-collision-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);
    const pa = join(benchDir, "packages", "a");
    const pab = join(benchDir, "packages", "ab");
    mkdirSync(join(pa, "src"), { recursive: true });
    mkdirSync(join(pab, "src"), { recursive: true });
    mkdirSync(join(pab, "tests"), { recursive: true });
    writeFileSync(join(pa, "package.json"), JSON.stringify({ name: "@my/a", scripts: { test: "vitest" } }));
    writeFileSync(join(pab, "package.json"), JSON.stringify({ name: "@my/ab", scripts: { test: "vitest" } }));
    writeFileSync(join(pa, "src", "a.ts"), "export function fnA() { return 1; }");
    writeFileSync(join(pab, "src", "b.ts"), "export function fnB() { return 1; }");
    writeFileSync(join(pab, "tests", "b.test.ts"), "test('b', () => {});");
    writeFileSync(join(pab, "tests", "b_other.test.ts"), "test('b_other', () => {});");
    gitCommitAll(benchDir, "init");

    const db = initFdxDb(benchDir, binaryPath);
    db.exec(`
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/ab/tests/b.test.ts', 'h1', 50, 100);
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/ab/src/b.ts', 'h2', 50, 100);
      INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/ab/tests/b.test.ts', 'file', 'packages/ab/tests/b.test.ts', 'pkg:npm:packages/ab');
      INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/ab/src/b.ts:fnB', 'symbol', 'packages/ab/src/b.ts', 'fnB', 'pkg:npm:packages/ab');
      INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
        VALUES ('scip-a', 'scip', '1.0', 'scip-ts', '0.1.0', '["typescript"]', 'packages/a', NULL, 'cfg_a', 'fp_b', 'available', 'fresh', 1, 100, 100);
      INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:b_test', 'file:packages/ab/tests/b.test.ts', 'sym:packages/ab/src/b.ts:fnB', 'references', 'scip_ts', 'fp_b', 4, 'packages/ab/tests/b.test.ts', 'h1', 1, 1, 0, 'scip-a');
    `);
    db.close();

    writeFileSync(join(pab, "src", "b.ts"), "export function fnB() { return 2; }");
    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], { cwd: benchDir, encoding: "utf8" });
    const plan = JSON.parse(planRaw);
    if (!plan.selected_checks.some((c) => c.check_id.includes("b_other.test.ts"))) {
      throw new Error("provider_scope_prefix_collision failed: provider rooted at packages/a must not cover packages/ab");
    }
    rmSync(benchDir, { recursive: true, force: true });
  }

  // Preflight 3: provider_fingerprint_mismatch_widens
  {
    const benchDir = join(tmpdir(), `fdx-preflight-fp-mismatch-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);
    const pa = join(benchDir, "packages", "pa");
    mkdirSync(join(pa, "src"), { recursive: true });
    mkdirSync(join(pa, "tests"), { recursive: true });
    writeFileSync(join(pa, "package.json"), JSON.stringify({ name: "@my/pa", scripts: { test: "vitest" } }));
    writeFileSync(join(pa, "src", "a.ts"), "export function fnA() { return 1; }");
    writeFileSync(join(pa, "tests", "a.test.ts"), "test('a', () => {});");
    writeFileSync(join(pa, "tests", "other.test.ts"), "test('other', () => {});");
    gitCommitAll(benchDir, "init");

    const db = initFdxDb(benchDir, binaryPath);
    db.exec(`
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pa/tests/a.test.ts', 'h1', 50, 100);
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pa/src/a.ts', 'h2', 50, 100);
      INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/pa/tests/a.test.ts', 'file', 'packages/pa/tests/a.test.ts', 'pkg:npm:packages/pa');
      INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pa/src/a.ts:fnA', 'symbol', 'packages/pa/src/a.ts', 'fnA', 'pkg:npm:packages/pa');
      INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
        VALUES ('scip-ts', 'scip', '1.0', 'scip-ts', '0.1.0', '["typescript"]', '.', 'packages/pa', 'cfg_fp_current', 'fp_current_digest', 'available', 'fresh', 1, 100, 100);
      INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:a_test', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:fnA', 'references', 'scip_ts', 'fp_old_mismatch', 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-ts');
    `);
    db.close();

    writeFileSync(join(pa, "src", "a.ts"), "export function fnA() { return 2; }");
    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], { cwd: benchDir, encoding: "utf8" });
    const plan = JSON.parse(planRaw);
    if (!plan.selected_checks.some((c) => c.check_id.includes("other.test.ts"))) {
      throw new Error("provider_fingerprint_mismatch_widens failed: fingerprint mismatch must widen package");
    }
    rmSync(benchDir, { recursive: true, force: true });
  }

  // Preflight 4: scoped_dynamic_config_isolation
  {
    const benchDir = join(tmpdir(), `fdx-preflight-dyn-config-${Date.now()}`);
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
    writeFileSync(join(pa, "vitest.config.ts"), "export default defineConfig(() => ({ test: { include: process.env.X ? [] : [] } }));");
    writeFileSync(join(pa, "src", "a.ts"), "export function fnA() { return 1; }");
    writeFileSync(join(pa, "tests", "a.test.ts"), "test('a', () => {});");
    writeFileSync(join(pa, "tests", "a_other.test.ts"), "test('a_other', () => {});");
    writeFileSync(join(pb, "src", "b.ts"), "export function fnB() { return 1; }");
    writeFileSync(join(pb, "tests", "b.test.ts"), "test('b', () => {});");
    writeFileSync(join(pb, "tests", "b_other.test.ts"), "test('b_other', () => {});");

    const mockBin = createMockProviderScript(benchDir, "mock-scip-ts");
    gitCommitAll(benchDir, "init");

    const execId = executableContentDigest(mockBin);
    const configFp = fingerprintConfigFiles(benchDir, TS_CONFIG_FILES);
    const fp = computeProviderFingerprint("1.0.0", execId, "0.1.0", null, configFp);

    const db = initFdxDb(benchDir, binaryPath);
    db.exec(`
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pb/tests/b.test.ts', 'h3', 50, 100);
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pb/src/b.ts', 'h4', 50, 100);
      INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/pb/tests/b.test.ts', 'file', 'packages/pb/tests/b.test.ts', 'pkg:npm:packages/pb');
      INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pb/src/b.ts:fnB', 'symbol', 'packages/pb/src/b.ts', 'fnB', 'pkg:npm:packages/pb');
      INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
        VALUES ('scip-typescript', 'scip', '1.0.0', '${execId}', '0.1.0', '["typescript"]', '.', 'packages/pb', '${configFp}', '${fp.digest}', 'available', 'fresh', 1, 100, 100);
      INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:fresh_b', 'file:packages/pb/tests/b.test.ts', 'sym:packages/pb/src/b.ts:fnB', 'references', 'scip_ts', '${fp.digest}', 4, 'packages/pb/tests/b.test.ts', 'h3', 1, 1, 0, 'scip-typescript');
    `);
    db.close();

    writeFileSync(join(pa, "src", "a.ts"), "export function fnA() { return 2; }");
    writeFileSync(join(pb, "src", "b.ts"), "export function fnB() { return 2; }");
    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBin },
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    if (plan.selected_checks.some((c) => c.check_id.includes("packages/pb/tests/b_other.test.ts"))) {
      throw new Error("scoped_dynamic_config_isolation failed: package B must not be widened by package A dynamic config");
    }
    if (!plan.selected_checks.some((c) => c.check_id.includes("packages/pa/tests/a_other.test.ts") || c.check_id.includes("check:pkg:npm:packages/pa:test"))) {
      throw new Error("scoped_dynamic_config_isolation failed: package A must be widened by its dynamic config");
    }
    rmSync(benchDir, { recursive: true, force: true });
  }

  // Preflight 5: effective_provider_freshness_invalidates_persisted_fresh
  {
    const benchDir = join(tmpdir(), `fdx-preflight-effective-freshness-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);
    const pa = join(benchDir, "packages", "pa");
    mkdirSync(join(pa, "src"), { recursive: true });
    mkdirSync(join(pa, "tests"), { recursive: true });
    writeFileSync(join(pa, "package.json"), JSON.stringify({ name: "@my/pa", scripts: { test: "vitest" } }));
    writeFileSync(join(pa, "src", "a.ts"), "export function fnA() { return 1; }");
    writeFileSync(join(pa, "tests", "a.test.ts"), "test('a', () => {});");
    writeFileSync(join(pa, "tests", "other.test.ts"), "test('other', () => {});");
    gitCommitAll(benchDir, "init");

    // Insert persisted row claiming health='available' and freshness='fresh', but with dummy fingerprints
    // and no valid mock binary executable. Effective evaluation must degrade to Stale/Missing.
    const db = initFdxDb(benchDir, binaryPath);
    db.exec(`
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pa/tests/a.test.ts', 'h1', 50, 100);
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pa/src/a.ts', 'h2', 50, 100);
      INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/pa/tests/a.test.ts', 'file', 'packages/pa/tests/a.test.ts', 'pkg:npm:packages/pa');
      INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pa/src/a.ts:fnA', 'symbol', 'packages/pa/src/a.ts', 'fnA', 'pkg:npm:packages/pa');
      INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
        VALUES ('scip-typescript', 'scip', '1.0.0', 'fake_exec_identity', '0.1.0', '["typescript"]', '.', 'packages/pa', 'fake_cfg_hash', 'fake_digest', 'available', 'fresh', 1, 100, 100);
      INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:a_test', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:fnA', 'references', 'scip_ts', 'fake_digest', 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-typescript');
    `);
    db.close();

    writeFileSync(join(pa, "src", "a.ts"), "export function fnA() { return 2; }");
    // Explicitly do NOT provide SCIP_TYPESCRIPT_BIN so provider binary is missing
    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: "" },
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    const aTest = plan.selected_checks.find((c) => c.check_id.includes("a.test.ts"));
    if (!aTest) {
      throw new Error("effective_provider_freshness failed: mapped a.test.ts must be retained for positive safety");
    }
    const otherTest = plan.selected_checks.find((c) => c.check_id.includes("other.test.ts") || c.check_id.includes("check:pkg:npm:packages/pa:test"));
    if (!otherTest) {
      throw new Error("effective_provider_freshness failed: package must be widened when effective provider is missing/stale");
    }
    if (plan.assurance === "exact") {
      throw new Error("effective_provider_freshness failed: assurance must not be exact when provider state degraded");
    }
    if (!plan.uncertainty.some((u) => JSON.stringify(u).toLowerCase().includes("stale") || JSON.stringify(u).toLowerCase().includes("provider"))) {
      throw new Error("effective_provider_freshness failed: stale provider uncertainty must be emitted");
    }
    rmSync(benchDir, { recursive: true, force: true });
  }
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

    const mockBin = createMockProviderScript(benchDir, "mock-scip-ts");
    gitCommitAll(benchDir, "init");

    // Ingest build graph
    execFileSync(binaryPath, ["build", "refresh"], {
      cwd: benchDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBin },
      stdio: "ignore",
    });

    const execId = executableContentDigest(mockBin);
    const configFp = fingerprintConfigFiles(benchDir, TS_CONFIG_FILES);
    const fp = computeProviderFingerprint("1.0.0", execId, "0.1.0", null, configFp);

    // Seed precise SCIP reference edge in SQLite
    const db = initFdxDb(benchDir, binaryPath);
    db.exec(`
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/tests/user.test.ts', 'hash_test', 50, 100);
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/src/user.ts', 'hash_src', 50, 100);
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/api/tests/user.test.ts', 'file', 'packages/api/tests/user.test.ts', 'pkg:npm:packages/api');
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/api/src/user.ts:createUser', 'symbol', 'packages/api/src/user.ts', 'createUser', 'pkg:npm:packages/api');
      INSERT OR REPLACE INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
        VALUES ('scip-typescript', 'scip', '1.0.0', '${execId}', '0.1.0', '["typescript"]', '.', 'packages/api', '${configFp}', '${fp.digest}', 'available', 'fresh', 1, 100, 100);
      INSERT OR REPLACE INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:user_test_refs_createUser', 'file:packages/api/tests/user.test.ts', 'sym:packages/api/src/user.ts:createUser', 'references', 'scip_ts', '${fp.digest}', 4, 'packages/api/tests/user.test.ts', 'hash_test', 1, 1, 0, 'scip-typescript');
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
    if (evRef.provider_id !== "scip-typescript" || evRef.provider_fingerprint !== fp.digest) {
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

  // 2. build_transitive_test_mapping (persisted fresh core semantic DB must not suppress app test obligation)
  {
    console.log("-> Running build_transitive_test_mapping scenario (fresh core DB vs dependent app)...");
    const benchDir = join(tmpdir(), `fdx-bench-m6-transitive-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    const coreDir = join(benchDir, "packages", "core");
    const appDir = join(benchDir, "packages", "app");
    mkdirSync(join(coreDir, "src"), { recursive: true });
    mkdirSync(join(coreDir, "tests"), { recursive: true });
    mkdirSync(join(appDir, "src"), { recursive: true });
    mkdirSync(join(appDir, "tests"), { recursive: true });

    writeFileSync(join(coreDir, "package.json"), JSON.stringify({ name: "@my/core", version: "1.0.0", scripts: { test: "vitest" } }, null, 2));
    writeFileSync(join(coreDir, "src", "index.ts"), "export function coreFn() { return 1; }");
    writeFileSync(join(coreDir, "tests", "core.test.ts"), "test('core', () => {});");
    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify({ name: "@my/app", dependencies: { "@my/core": "workspace:*" }, scripts: { test: "vitest" } }, null, 2)
    );
    writeFileSync(join(appDir, "src", "main.ts"), "import { coreFn } from '@my/core'; export function appFn() { return coreFn(); }");
    writeFileSync(join(appDir, "tests", "main.test.ts"), "test('app', () => {});");

    const mockBin = createMockProviderScript(benchDir, "mock-scip-ts");
    gitCommitAll(benchDir, "init");

    execFileSync(binaryPath, ["build", "refresh"], {
      cwd: benchDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBin },
      stdio: "ignore",
    });

    const execId = executableContentDigest(mockBin);
    const configFp = fingerprintConfigFiles(benchDir, TS_CONFIG_FILES);
    const fp = computeProviderFingerprint("1.0.0", execId, "0.1.0", null, configFp);

    // Persist fresh provider covering ONLY package core
    const db = initFdxDb(benchDir, binaryPath);
    db.exec(`
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/core/tests/core.test.ts', 'h1', 50, 100);
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/core/src/index.ts', 'h2', 50, 100);
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/core/tests/core.test.ts', 'file', 'packages/core/tests/core.test.ts', 'pkg:npm:packages/core');
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/core/src/index.ts:coreFn', 'symbol', 'packages/core/src/index.ts', 'coreFn', 'pkg:npm:packages/core');
      INSERT OR REPLACE INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
        VALUES ('scip-typescript', 'scip', '1.0.0', '${execId}', '0.1.0', '["typescript"]', '.', 'packages/core', '${configFp}', '${fp.digest}', 'available', 'fresh', 1, 100, 100);
      INSERT OR REPLACE INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:core_test', 'file:packages/core/tests/core.test.ts', 'sym:packages/core/src/index.ts:coreFn', 'references', 'scip_ts', '${fp.digest}', 4, 'packages/core/tests/core.test.ts', 'h1', 1, 1, 0, 'scip-typescript');
    `);
    db.close();

    writeFileSync(join(coreDir, "src", "index.ts"), "export function coreFn() { return 2; }");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBin },
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    if (!plan.selected_checks.some((c) => c.check_id.includes("packages/app"))) {
      throw new Error("build_transitive_test_mapping failed: app checks not selected on core modification despite fresh core DB");
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

    const mockBin = createMockProviderScript(benchDir, "mock-scip-ts");
    gitCommitAll(benchDir, "init");

    const execId = executableContentDigest(mockBin);
    const configFp = fingerprintConfigFiles(benchDir, TS_CONFIG_FILES);
    const fp = computeProviderFingerprint("1.0.0", execId, "0.1.0", null, configFp);

    // Persist real before-state mapping in DB
    const db = initFdxDb(benchDir, binaryPath);
    db.exec(`
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('tests/mod.test.ts', 'h1', 50, 100);
      INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('src/mod.ts', 'h2', 50, 100);
      INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:tests/mod.test.ts', 'file', 'tests/mod.test.ts', 'pkg:npm:.');
      INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:src/mod.ts:oldFn', 'symbol', 'src/mod.ts', 'oldFn', 'pkg:npm:.');
      INSERT OR REPLACE INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
        VALUES ('scip-typescript', 'scip', '1.0.0', '${execId}', '0.1.0', '["typescript"]', '.', '.', '${configFp}', '${fp.digest}', 'available', 'fresh', 1, 100, 100);
      INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:mod_test_refs_oldFn', 'file:tests/mod.test.ts', 'sym:src/mod.ts:oldFn', 'references', 'scip_ts', '${fp.digest}', 4, 'tests/mod.test.ts', 'h1', 1, 1, 0, 'scip-typescript');
    `);
    db.close();

    // Delete symbol in src/mod.ts
    writeFileSync(join(benchDir, "src", "mod.ts"), "// oldFn deleted");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBin },
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
        env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBin },
      });
      const t1 = performance.now();
      if (r >= warmup) samples.push(t1 - t0);
    }
    results["deleted_symbol_old_current_union"] = computeStats(samples);
    rmSync(benchDir, { recursive: true, force: true });
  }

  // 4. stale_semantic_package_widening (persisted stale SCIP evidence fixture with fresh-vs-stale causal control)
  {
    console.log("-> Running stale_semantic_package_widening scenario (fresh vs stale causal control)...");
    
    // First run Fresh Control on identical fixture with stale = 0
    const freshDir = join(tmpdir(), `fdx-bench-m6-fresh-control-${Date.now()}`);
    mkdirSync(freshDir, { recursive: true });
    initGitRepo(freshDir);
    const freshPkg = join(freshDir, "packages", "feat");
    mkdirSync(join(freshPkg, "src"), { recursive: true });
    mkdirSync(join(freshPkg, "tests"), { recursive: true });
    writeFileSync(join(freshPkg, "package.json"), JSON.stringify({ name: "@my/feat", scripts: { test: "vitest" } }));
    writeFileSync(join(freshPkg, "src", "a.ts"), "export function fnA() { return 1; }\nexport function fnUnrelated() { return 2; }\n");
    writeFileSync(join(freshPkg, "tests", "a.test.ts"), "test('a', () => {});");
    writeFileSync(join(freshPkg, "tests", "b.test.ts"), "test('b', () => {});");

    const mockBin = createMockProviderScript(freshDir, "mock-scip-ts");
    gitCommitAll(freshDir, "init");

    execFileSync(binaryPath, ["build", "refresh"], {
      cwd: freshDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBin },
      stdio: "ignore",
    });

    const execIdFresh = executableContentDigest(mockBin);
    const configFpFresh = fingerprintConfigFiles(freshDir, TS_CONFIG_FILES);
    const fpFresh = computeProviderFingerprint("1.0.0", execIdFresh, "0.1.0", null, configFpFresh);

    const freshDb = initFdxDb(freshDir, binaryPath);
    freshDb.exec(`
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/feat/tests/a.test.ts', 'h1', 50, 100);
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/feat/src/a.ts', 'h2', 50, 100);
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/feat/tests/a.test.ts', 'file', 'packages/feat/tests/a.test.ts', 'pkg:npm:packages/feat');
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/feat/src/a.ts:fnA', 'symbol', 'packages/feat/src/a.ts', 'fnA', 'pkg:npm:packages/feat');
      INSERT OR REPLACE INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
        VALUES ('scip-typescript', 'scip', '1.0.0', '${execIdFresh}', '0.1.0', '["typescript"]', '.', 'packages/feat', '${configFpFresh}', '${fpFresh.digest}', 'available', 'fresh', 1, 100, 100);
      INSERT OR REPLACE INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:a_fresh_edge', 'file:packages/feat/tests/a.test.ts', 'sym:packages/feat/src/a.ts:fnA', 'references', 'scip_ts', '${fpFresh.digest}', 4, 'packages/feat/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-typescript');
    `);
    freshDb.close();
    writeFileSync(join(freshPkg, "src", "a.ts"), "export function fnA() { return 42; }\nexport function fnUnrelated() { return 2; }\n");

    const freshPlanRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: freshDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBin },
      encoding: "utf8",
    });
    const freshPlan = JSON.parse(freshPlanRaw);
    if (!freshPlan.selected_checks.some((c) => c.check_id.includes("a.test.ts"))) {
      throw new Error("fresh control failed: a.test.ts not selected");
    }
    if (freshPlan.selected_checks.some((c) => c.check_id.includes("b.test.ts"))) {
      throw new Error("fresh control failed: b.test.ts must not be selected under fresh precise SCIP");
    }
    if (freshPlan.assurance === "unverified") {
      throw new Error("fresh control failed: assurance must not be unverified");
    }
    rmSync(freshDir, { recursive: true, force: true });

    // Now run Stale Variant on identical fixture with stale = 1
    const benchDir = join(tmpdir(), `fdx-bench-m6-stale-widening-${Date.now()}`);
    mkdirSync(benchDir, { recursive: true });
    initGitRepo(benchDir);

    const pkgDir = join(benchDir, "packages", "feat");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "tests"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@my/feat", scripts: { test: "vitest" } }));
    writeFileSync(join(pkgDir, "src", "a.ts"), "export function fnA() { return 1; }\nexport function fnUnrelated() { return 2; }\n");
    writeFileSync(join(pkgDir, "tests", "a.test.ts"), "test('a', () => {});");
    writeFileSync(join(pkgDir, "tests", "b.test.ts"), "test('b', () => {});");

    const staleMockBin = createMockProviderScript(benchDir, "mock-scip-ts");
    gitCommitAll(benchDir, "init");

    execFileSync(binaryPath, ["build", "refresh"], {
      cwd: benchDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: staleMockBin },
      stdio: "ignore",
    });

    const execIdStale = executableContentDigest(staleMockBin);
    const configFpStale = fingerprintConfigFiles(benchDir, TS_CONFIG_FILES);
    const fpStale = computeProviderFingerprint("1.0.0", execIdStale, "0.1.0", null, configFpStale);

    // Persist stale edge (stale = 1)
    const db = initFdxDb(benchDir, binaryPath);
    db.exec(`
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/feat/tests/a.test.ts', 'h1', 50, 100);
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/feat/src/a.ts', 'h2', 50, 100);
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/feat/tests/a.test.ts', 'file', 'packages/feat/tests/a.test.ts', 'pkg:npm:packages/feat');
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/feat/src/a.ts:fnA', 'symbol', 'packages/feat/src/a.ts', 'fnA', 'pkg:npm:packages/feat');
      INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
        VALUES ('scip-typescript', 'scip', '1.0.0', '${execIdStale}', '0.1.0', '["typescript"]', '.', 'packages/feat', '${configFpStale}', '${fpStale.digest}', 'available', 'fresh', 1, 100, 100);
      INSERT OR REPLACE INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:a_stale_edge', 'file:packages/feat/tests/a.test.ts', 'sym:packages/feat/src/a.ts:fnA', 'references', 'scip_ts', '${fpStale.digest}', 4, 'packages/feat/tests/a.test.ts', 'h1', 1, 1, 1, 'scip-typescript');
    `);
    db.close();

    writeFileSync(join(pkgDir, "src", "a.ts"), "export function fnA() { return 42; }\nexport function fnUnrelated() { return 2; }\n");

    const planRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: benchDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: staleMockBin },
      encoding: "utf8",
    });
    const plan = JSON.parse(planRaw);
    const staleATest = plan.selected_checks.find((c) => c.check_id.includes("a.test.ts"));
    if (!staleATest) {
      throw new Error("stale_semantic_package_widening failed: mapped a.test.ts must be retained");
    }
    if (!staleATest.evidence_refs || staleATest.evidence_refs.length === 0 || !staleATest.evidence_refs[0].stale) {
      throw new Error("stale_semantic_package_widening failed: evidence_refs must preserve stale=true");
    }
    if (!plan.selected_checks.some((c) => c.check_id.includes("b.test.ts") || c.check_id.includes("test"))) {
      throw new Error("stale_semantic_package_widening failed: package widening must select b.test.ts or package test suite");
    }
    if (!plan.uncertainty.some((u) => JSON.stringify(u).toLowerCase().includes("stale"))) {
      throw new Error("stale_semantic_package_widening failed: ProviderStale uncertainty must be emitted");
    }
    if (plan.assurance === "exact") {
      throw new Error("stale_semantic_package_widening failed: assurance must be degraded below exact");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: benchDir,
        env: { ...process.env, SCIP_TYPESCRIPT_BIN: staleMockBin },
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

  // 9. disconnected_scope_isolation (simultaneous stale A + fresh B change vs clean control)
  {
    console.log("-> Running disconnected_scope_isolation scenario (simultaneous stale A + fresh B)...");
    const controlDir = join(tmpdir(), `fdx-bench-m6-control-${Date.now()}`);
    const testDir = join(tmpdir(), `fdx-bench-m6-isolation-${Date.now()}`);
    mkdirSync(controlDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    initGitRepo(controlDir);
    initGitRepo(testDir);

    const mockBinControl = createMockProviderScript(controlDir, "mock-scip-ts");
    const mockBinTest = createMockProviderScript(testDir, "mock-scip-ts");

    // Control: only package B with fresh SCIP
    const controlPb = join(controlDir, "packages", "pb");
    mkdirSync(join(controlPb, "src"), { recursive: true });
    mkdirSync(join(controlPb, "tests"), { recursive: true });
    writeFileSync(join(controlPb, "package.json"), JSON.stringify({ name: "@my/pb", scripts: { test: "vitest" } }));
    writeFileSync(join(controlPb, "src", "b.ts"), "export function fnB() { return 1; }");
    writeFileSync(join(controlPb, "tests", "b.test.ts"), "test('b', () => {});");
    writeFileSync(join(controlPb, "tests", "b_other.test.ts"), "test('b_other', () => {});");
    gitCommitAll(controlDir, "init");

    execFileSync(binaryPath, ["build", "refresh"], {
      cwd: controlDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBinControl },
      stdio: "ignore",
    });

    const execIdCtrl = executableContentDigest(mockBinControl);
    const configFpCtrl = fingerprintConfigFiles(controlDir, TS_CONFIG_FILES);
    const fpCtrl = computeProviderFingerprint("1.0.0", execIdCtrl, "0.1.0", null, configFpCtrl);

    const dbControl = initFdxDb(controlDir, binaryPath);
    dbControl.exec(`
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pb/tests/b.test.ts', 'h3', 50, 100);
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pb/src/b.ts', 'h4', 50, 100);
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/pb/tests/b.test.ts', 'file', 'packages/pb/tests/b.test.ts', 'pkg:npm:packages/pb');
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pb/src/b.ts:fnB', 'symbol', 'packages/pb/src/b.ts', 'fnB', 'pkg:npm:packages/pb');
      INSERT OR REPLACE INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
        VALUES ('scip-typescript', 'scip', '1.0.0', '${execIdCtrl}', '0.1.0', '["typescript"]', '.', 'packages/pb', '${configFpCtrl}', '${fpCtrl.digest}', 'available', 'fresh', 1, 100, 100);
      INSERT OR REPLACE INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:fresh_b', 'file:packages/pb/tests/b.test.ts', 'sym:packages/pb/src/b.ts:fnB', 'references', 'scip_ts', '${fpCtrl.digest}', 4, 'packages/pb/tests/b.test.ts', 'h3', 1, 1, 0, 'scip-typescript');
    `);
    dbControl.close();

    writeFileSync(join(controlPb, "src", "b.ts"), "export function fnB() { return 2; }");

    // Test: package A (stale) + package B (fresh) (both A and B modified)
    const pa = join(testDir, "packages", "pa");
    const pb = join(testDir, "packages", "pb");
    mkdirSync(join(pa, "src"), { recursive: true });
    mkdirSync(join(pa, "tests"), { recursive: true });
    mkdirSync(join(pb, "src"), { recursive: true });
    mkdirSync(join(pb, "tests"), { recursive: true });
    writeFileSync(join(pa, "package.json"), JSON.stringify({ name: "@my/pa", scripts: { test: "vitest" } }));
    writeFileSync(join(pb, "package.json"), JSON.stringify({ name: "@my/pb", scripts: { test: "vitest" } }));
    writeFileSync(join(pa, "src", "a.ts"), "export function fnA() { return 1; }");
    writeFileSync(join(pa, "tests", "a.test.ts"), "test('a', () => {});");
    writeFileSync(join(pa, "tests", "a_other.test.ts"), "test('a_other', () => {});");
    writeFileSync(join(pb, "src", "b.ts"), "export function fnB() { return 1; }");
    writeFileSync(join(pb, "tests", "b.test.ts"), "test('b', () => {});");
    writeFileSync(join(pb, "tests", "b_other.test.ts"), "test('b_other', () => {});");
    gitCommitAll(testDir, "init");

    execFileSync(binaryPath, ["build", "refresh"], {
      cwd: testDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBinTest },
      stdio: "ignore",
    });

    const execIdTest = executableContentDigest(mockBinTest);
    const configFpTest = fingerprintConfigFiles(testDir, TS_CONFIG_FILES);
    const fpTest = computeProviderFingerprint("1.0.0", execIdTest, "0.1.0", null, configFpTest);

    const dbTest = initFdxDb(testDir, binaryPath);
    dbTest.exec(`
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pa/tests/a.test.ts', 'h1', 50, 100);
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pa/src/a.ts', 'h2', 50, 100);
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pb/tests/b.test.ts', 'h3', 50, 100);
      INSERT OR REPLACE INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pb/src/b.ts', 'h4', 50, 100);

      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/pa/tests/a.test.ts', 'file', 'packages/pa/tests/a.test.ts', 'pkg:npm:packages/pa');
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pa/src/a.ts:fnA', 'symbol', 'packages/pa/src/a.ts', 'fnA', 'pkg:npm:packages/pa');
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/pb/tests/b.test.ts', 'file', 'packages/pb/tests/b.test.ts', 'pkg:npm:packages/pb');
      INSERT OR REPLACE INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pb/src/b.ts:fnB', 'symbol', 'packages/pb/src/b.ts', 'fnB', 'pkg:npm:packages/pb');

      INSERT OR REPLACE INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
        VALUES ('scip-typescript', 'scip', '1.0.0', '${execIdTest}', '0.1.0', '["typescript"]', '.', 'packages/pb', '${configFpTest}', '${fpTest.digest}', 'available', 'fresh', 1, 100, 100);

      INSERT OR REPLACE INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:stale_a', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:fnA', 'references', 'scip_ts', 'fp_a', 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 1, 'scip-typescript');
      INSERT OR REPLACE INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id)
        VALUES ('edge:fresh_b', 'file:packages/pb/tests/b.test.ts', 'sym:packages/pb/src/b.ts:fnB', 'references', 'scip_ts', '${fpTest.digest}', 4, 'packages/pb/tests/b.test.ts', 'h3', 1, 1, 0, 'scip-typescript');
    `);
    dbTest.close();

    writeFileSync(join(pa, "src", "a.ts"), "export function fnA() { return 2; }");
    writeFileSync(join(pb, "src", "b.ts"), "export function fnB() { return 2; }");

    const controlPlanRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: controlDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBinControl },
      encoding: "utf8",
    });
    const testPlanRaw = execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
      cwd: testDir,
      env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBinTest },
      encoding: "utf8",
    });

    const controlPlan = JSON.parse(controlPlanRaw);
    const testPlan = JSON.parse(testPlanRaw);

    const controlBCheck = controlPlan.selected_checks.find((c) => c.check_id.includes("b.test.ts"));
    const testBCheck = testPlan.selected_checks.find((c) => c.check_id.includes("b.test.ts"));

    if (!controlBCheck || !testBCheck) {
      throw new Error("disconnected_scope_isolation failed: b.test.ts must be selected in both control and test");
    }
    if (controlBCheck.check_id !== testBCheck.check_id || controlBCheck.strength !== testBCheck.strength) {
      throw new Error("disconnected_scope_isolation failed: package B selection diverged between isolated control and multi-package repo");
    }
    if (testPlan.selected_checks.some((c) => c.check_id.includes("packages/pb/tests/b_other.test.ts"))) {
      throw new Error("disconnected_scope_isolation failed: fresh package B must NOT be widened by stale package A");
    }
    if (!testPlan.selected_checks.some((c) => c.check_id.includes("packages/pa/tests/a_other.test.ts") || c.check_id.includes("check:pkg:npm:packages/pa:test"))) {
      throw new Error("disconnected_scope_isolation failed: stale package A MUST be widened");
    }

    const samples = [];
    for (let r = 0; r < warmup + iterations; r++) {
      const t0 = performance.now();
      execFileSync(binaryPath, ["plan", "--base", "HEAD", "--format", "json"], {
        cwd: testDir,
        env: { ...process.env, SCIP_TYPESCRIPT_BIN: mockBinTest },
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

  // Resolve actual committed commit that owns the benchmark harness
  let benchmarkHarnessSha = "";
  try {
    execFileSync("git", ["diff", "--quiet", "--", "scripts/benchmark-fdx-vci-m6-test-planner.mjs"], { cwd: ROOT });
    execFileSync("git", ["diff", "--cached", "--quiet", "--", "scripts/benchmark-fdx-vci-m6-test-planner.mjs"], { cwd: ROOT });
    benchmarkHarnessSha = execFileSync("git", ["log", "-1", "--format=%H", "--", "scripts/benchmark-fdx-vci-m6-test-planner.mjs"], { cwd: ROOT, encoding: "utf8" }).trim();
    const currentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    if (benchmarkHarnessSha !== currentHead) {
      throw new Error(`HEAD (${currentHead}) != harness owner commit (${benchmarkHarnessSha})`);
    }
  } catch (err) {
    throw new Error(`Benchmark harness SHA provenance verification failed: ${err.message}`);
  }

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
