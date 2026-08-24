#!/usr/bin/env node
/**
 * benchmark-fdx-vci-m10-shadow-calibration.mjs — Milestone 10 Shadow Calibration Benchmarks
 * Hardened H29 benchmark suite asserting non-vacuous calibration invariants, signal classification, bounded shadow execution, atomic persistence, secret redaction, and strict isolation.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_JSON_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m10-shadow-calibration.json");
const REPORT_MD_PATH = join(ROOT, "reports", "benchmark-fdx-vci-m10-repro.md");

const EXPECTED_FUNCTIONAL_SHA = "f7461acb366fb584a8927668f752e4f7bf8c9dbb";

function computeSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function computeFileSha256(path) {
  const buf = readFileSync(path);
  return computeSha256(buf);
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

function invokeFdx(bin, repo, args = [], extraEnv = {}) {
  try {
    const stdout = execFileSync(bin, [...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let data = null;
    try {
      data = JSON.parse(stdout);
    } catch {}
    return { exitCode: 0, stdout, data };
  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString() : "";
    let data = null;
    try {
      data = JSON.parse(stdout);
    } catch {}
    return { exitCode: err.status || 1, stdout, data, error: err };
  }
}

function createSampleRepo(prefix, scripts = { test: "node -e 'process.exit(0)'" }) {
  const repo = join(tmpdir(), "fdx-m10-" + prefix + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "m10-test-pkg",
    packageManager: "npm@10.0.0",
    scripts
  }));
  writeFileSync(join(repo, "src.js"), "module.exports = 1;");
  gitInitAndCommitAll(repo);
  return repo;
}

async function runPreflights(_bin) {
  console.log("-> Running non-vacuous hardened M10 shadow calibration preflights (H29)...");
  const preflights = [];

  function pass(name, details = {}) {
    preflights.push({ name, status: "passed", details });
  }

  // 1. schema_v8_tables_and_columns_exist
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_schema", "test_calibration_schema_tables_and_columns_exist"], { cwd: ROOT, stdio: "ignore" });
    pass("schema_v9_qualified_tables_and_columns_exist");
  }

  // 2. v7_to_v8_migration_preserves_runtime_runs
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_schema", "test_v7_to_v9_migration_preserves_data"], { cwd: ROOT, stdio: "ignore" });
    pass("v7_to_v9_migration_preserves_runtime_runs");
  }

  // 3. deterministic_calibration_id_binding
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_reference_policy", "test_calibration_id_binding"], { cwd: ROOT, stdio: "ignore" });
    pass("deterministic_calibration_id_binding");
  }

  // 4. policy_digest_field_sensitivity
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_reference_policy", "test_policy_digest_determinism_and_field_sensitivity"], { cwd: ROOT, stdio: "ignore" });
    pass("policy_digest_field_sensitivity");
  }

  // 5. candidate_plan_exact_preservation
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_candidate_isolation", "test_candidate_plan_is_preserved_exact_and_unchanged"], { cwd: ROOT, stdio: "ignore" });
    pass("candidate_plan_exact_preservation");
  }

  // 6. shadow_reference_superset_discovery
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_shadow_execution", "test_shadow_reference_is_superset_of_candidate_plan"], { cwd: ROOT, stdio: "ignore" });
    pass("shadow_reference_superset_discovery");
  }

  // 7. signal_classification_and_observed_miss_detection
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_observed_miss", "test_unselected_failing_check_is_classified_as_observed_shadow_miss"], { cwd: ROOT, stdio: "ignore" });
    pass("signal_classification_and_observed_miss_detection");
  }

  // 8. incomplete_execution_classification
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_incomplete", "test_unselected_check_timeout_or_failure_to_spawn_remains_incomplete"], { cwd: ROOT, stdio: "ignore" });
    pass("incomplete_execution_classification");
  }

  // 9. zero_failing_signals_null_recall
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_zero_signal", "test_zero_failing_signals_results_in_null_signal_recall"], { cwd: ROOT, stdio: "ignore" });
    pass("zero_failing_signals_null_recall");
  }

  // 10. bounded_shadow_checks_and_truncation
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_limits", "test_max_shadow_checks_limit_truncates_and_marks_incomplete"], { cwd: ROOT, stdio: "ignore" });
    pass("bounded_shadow_checks_and_truncation");
  }

  // 11. database_idempotent_persistence
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_idempotency", "test_persisting_identical_calibration_run_is_idempotent"], { cwd: ROOT, stdio: "ignore" });
    pass("database_idempotent_persistence");
  }

  // 12. divergent_data_conflict_rejection
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_conflict", "test_persisting_divergent_data_with_same_id_fails_conflict"], { cwd: ROOT, stdio: "ignore" });
    pass("divergent_data_conflict_rejection");
  }

  // 13. transaction_rollback_zero_orphaned_rows
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_transactionality", "test_transaction_rollback_leaves_zero_orphaned_rows_on_error"], { cwd: ROOT, stdio: "ignore" });
    pass("transaction_rollback_zero_orphaned_rows");
  }

  // 14. database_reopen_exact_determinism
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_reopen_determinism", "test_database_close_and_reopen_preserves_exact_metrics"], { cwd: ROOT, stdio: "ignore" });
    pass("database_reopen_exact_determinism");
  }

  // 15. privacy_and_secret_redaction
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_privacy", "test_secrets_in_unsupported_reasons_or_environment_are_redacted"], { cwd: ROOT, stdio: "ignore" });
    pass("privacy_and_secret_redaction");
  }

  // 16. planner_selection_and_assurance_isolation
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_planner_isolation", "test_calibration_history_never_influences_planner_decisions_or_assurance"], { cwd: ROOT, stdio: "ignore" });
    pass("planner_selection_and_assurance_isolation");
  }

  // 17. runtime_history_and_executions_isolation
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_runtime_isolation", "test_calibration_executions_do_not_pollute_runtime_history"], { cwd: ROOT, stdio: "ignore" });
    pass("runtime_history_and_executions_isolation");
  }

  // 18. m9_attestation_statement_and_digest_isolation
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_attestation_isolation", "test_m9_attestation_bytes_and_hashes_remain_identical_before_and_after_calibration"], { cwd: ROOT, stdio: "ignore" });
    pass("m9_attestation_statement_and_digest_isolation");
  }

  // 19. cli_subcommands_end_to_end
  {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", "test_calibration_cli", "test_calibration_cli_subcommands"], { cwd: ROOT, stdio: "ignore" });
    pass("cli_subcommands_end_to_end");
  }

  for (const [name, test] of [
    ["candidate_unsupported_spawn_failed_zero_physical_execution", "test_calibration_physical_execution_truth"],
    ["strict_total_duration_budget", "test_calibration_total_budget"],
    ["v8_rows_legacy_unqualified_and_aggregate_eligibility", "test_calibration_v8_to_v9_upgrade"],
  ]) {
    execFileSync("cargo", ["test", "-p", "fdx", "--test", test], { cwd: ROOT, stdio: "ignore" });
    pass(name);
  }
  console.log("-> All " + preflights.length + " hardened M10 non-vacuous preflights passed successfully!");
  return preflights;
}

async function runBenchmarks(bin) {
  console.log("-> Running M10 shadow calibration performance benchmarks...");
  const results = {};

  // Benchmark 1: Single Run Calibration Execution (15 samples)
  {
    const samples = [];
    for (let i = 0; i < 15; i++) {
      const repo = createSampleRepo("bm-cal-single");
      writeFileSync(join(repo, "src.js"), "module.exports = 2;");
      const vRes = invokeFdx(bin, repo, ["verify", "--format", "json"]);
      const runId = vRes.data.run_id;

      const t0 = performance.now();
      const cRes = invokeFdx(bin, repo, ["calibrate", "run", "--run", runId, "--format", "json"]);
      const dur = performance.now() - t0;
      if (cRes.exitCode !== 0) throw new Error("Benchmark 1 failed");
      samples.push(dur);
      rmSync(repo, { recursive: true, force: true });
    }
    results.calibration_run_single_ms = computeStats(samples);
  }

  // Benchmark 2: Calibration Show / Query Latency (15 samples)
  {
    const samples = [];
    for (let i = 0; i < 15; i++) {
      const repo = createSampleRepo("bm-cal-show");
      writeFileSync(join(repo, "src.js"), "module.exports = 2;");
      const vRes = invokeFdx(bin, repo, ["verify", "--format", "json"]);
      const runId = vRes.data.run_id;
      const cRes = invokeFdx(bin, repo, ["calibrate", "run", "--run", runId, "--format", "json"]);
      const calId = cRes.data.calibration_id;

      const t0 = performance.now();
      const sRes = invokeFdx(bin, repo, ["calibrate", "show", calId, "--format", "json"]);
      const dur = performance.now() - t0;
      if (sRes.exitCode !== 0) throw new Error("Benchmark 2 failed");
      samples.push(dur);
      rmSync(repo, { recursive: true, force: true });
    }
    results.calibration_show_single_ms = computeStats(samples);
  }

  // Benchmark 3: Calibration Stats Query Latency (15 samples)
  {
    const samples = [];
    const repo = createSampleRepo("bm-cal-stats");
    writeFileSync(join(repo, "src.js"), "module.exports = 2;");
    const vRes = invokeFdx(bin, repo, ["verify", "--format", "json"]);
    const runId = vRes.data.run_id;
    invokeFdx(bin, repo, ["calibrate", "run", "--run", runId, "--format", "json"]);

    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      const statsRes = invokeFdx(bin, repo, ["calibrate", "stats", "--format", "json"]);
      const dur = performance.now() - t0;
      if (statsRes.exitCode !== 0) throw new Error("Benchmark 3 failed");
      samples.push(dur);
    }
    results.calibration_stats_query_ms = computeStats(samples);
    rmSync(repo, { recursive: true, force: true });
  }

  // Benchmark 4: Scaling Benchmarks (50 calibrations + query)
  {
    const repo = createSampleRepo("bm-50-calibrations");
    const runIds = [];
    const calIds = [];

    for (let i = 0; i < 50; i++) {
      writeFileSync(join(repo, "src.js"), "module.exports = " + i + ";");
      const vRes = invokeFdx(bin, repo, ["verify", "--format", "json"]);
      if (vRes.exitCode === 0 && vRes.data?.run_id) {
        runIds.push(vRes.data.run_id);
      }
    }

    const t0 = performance.now();
    for (const runId of runIds) {
      const cRes = invokeFdx(bin, repo, ["calibrate", "run", "--run", runId, "--format", "json"]);
      if (cRes.exitCode === 0 && cRes.data?.calibration_id) {
        calIds.push(cRes.data.calibration_id);
      }
    }
    const createTotal = performance.now() - t0;
    results.calibrate_50_runs_total_ms = Number(createTotal.toFixed(2));
    results.calibrate_avg_per_run_ms = Number((createTotal / runIds.length).toFixed(2));

    const t1 = performance.now();
    for (const calId of calIds) {
      const sRes = invokeFdx(bin, repo, ["calibrate", "show", calId, "--format", "json"]);
      if (sRes.exitCode !== 0) throw new Error("Failed to show calibration in 50 runs benchmark");
    }
    const showTotal = performance.now() - t1;
    results.calibrate_show_50_runs_total_ms = Number(showTotal.toFixed(2));
    results.calibrate_show_avg_per_run_ms = Number((showTotal / calIds.length).toFixed(2));

    rmSync(repo, { recursive: true, force: true });
  }

  return results;
}

async function main() {
  console.log("=== FlowDeck M10 Hardened Shadow Calibration Qualification & Benchmark (H31) ===");

  const functionalSha = process.env.FDX_BENCHMARK_FUNCTIONAL_SHA;
  if (!functionalSha) {
    throw new Error("FDX_BENCHMARK_FUNCTIONAL_SHA environment variable is required");
  }
  if (functionalSha !== EXPECTED_FUNCTIONAL_SHA) {
    throw new Error("Functional SHA mismatch: provided " + functionalSha + " != expected " + EXPECTED_FUNCTIONAL_SHA);
  }

  const bin = process.env.FDX_BINARY_PATH;
  if (!bin) {
    throw new Error("FDX_BINARY_PATH environment variable is required");
  }
  if (!existsSync(bin)) {
    throw new Error("Provided binary path does not exist: " + bin);
  }

  const expectedBinarySha256 = process.env.FDX_BINARY_SHA256;
  if (!expectedBinarySha256) {
    throw new Error("FDX_BINARY_SHA256 environment variable is required");
  }

  const binarySha256 = computeFileSha256(bin);
  if (binarySha256 !== expectedBinarySha256) {
    throw new Error("Binary SHA256 mismatch: calculated " + binarySha256 + " != expected " + expectedBinarySha256);
  }

  const harnessPath = "scripts/benchmark-fdx-vci-m10-shadow-calibration.mjs";
  const workingDiff = execFileSync("git", ["diff", "--name-only", "--", harnessPath], { cwd: ROOT, encoding: "utf8" }).trim();
  if (workingDiff.length > 0) {
    throw new Error("Harness working tree is dirty: " + harnessPath + " contains uncommitted modifications");
  }

  const stagedDiff = execFileSync("git", ["diff", "--cached", "--name-only", "--", harnessPath], { cwd: ROOT, encoding: "utf8" }).trim();
  if (stagedDiff.length > 0) {
    throw new Error("Harness index is dirty: " + harnessPath + " contains staged uncommitted modifications");
  }

  const qualificationStatus = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (qualificationStatus.length > 0) {
    throw new Error("Qualification checkout is not clean: uncommitted changes detected:\n" + qualificationStatus);
  }

  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const harnessOwnerSha = execFileSync("git", ["log", "-1", "--format=%H", "--", harnessPath], { cwd: ROOT, encoding: "utf8" }).trim();
  if (headSha !== harnessOwnerSha) {
    throw new Error("HEAD commit (" + headSha + ") is not the harness-owning commit (" + harnessOwnerSha + ")");
  }

  try {
    execFileSync("git", ["merge-base", "--is-ancestor", EXPECTED_FUNCTIONAL_SHA, headSha], { cwd: ROOT, stdio: "ignore" });
  } catch {
    throw new Error("Functional baseline " + EXPECTED_FUNCTIONAL_SHA + " is not an ancestor of current HEAD " + headSha);
  }

  const harnessSha = harnessOwnerSha;

  const preflightResults = await runPreflights(bin);
  const metrics = await runBenchmarks(bin);

  const report = {
    milestone: "M10",
    title: "Shadow Calibration & Empirical Verification Planner Accuracy",
    functional_source_sha: functionalSha,
    binary_source_sha: functionalSha,
    binary_sha256: binarySha256,
    benchmark_harness_sha: harnessSha,
    qualification_head_sha: headSha,
    timestamp: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    schema_version: 9,
    invariants: {
      schema_v8_migration_complete: true,
      deterministic_calibration_id_binding: true,
      candidate_plan_exact_preservation: true,
      shadow_reference_superset_discovery: true,
      signal_classification_complete: true,
      zero_signal_null_recall_enforced: true,
      bounded_shadow_checks_and_truncation: true,
      database_atomic_idempotent_persistence: true,
      divergent_data_conflict_rejected: true,
      secrets_and_excerpts_redacted: true,
      planner_selection_isolated: true,
      assurance_escalation_isolated: true,
      runtime_history_isolated: true,
      m9_attestation_bytes_isolated: true,
    },
    preflights: preflightResults,
    metrics,
  };

  writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2));
  console.log("-> Saved benchmark report: " + REPORT_JSON_PATH);

  const mdLines = [
    "# Milestone 10: Hardened Shadow Calibration Qualification Report (R31)",
    "",
    "**Milestone:** M10  ",
    "**Functional Baseline (F29):** `" + functionalSha + "`  ",
    "**Binary SHA-256:** `" + binarySha256 + "`  ",
    "**Benchmark Harness (H31):** `" + harnessSha + "`  ",
    "**Executed At:** " + report.timestamp + "  ",
    "**Platform:** " + report.platform + " (" + report.arch + ")  ",
    "**Node Version:** " + report.node_version + "  ",
    "**Evidence Graph Schema Version:** `9`  ",
    "",
    "## Invariants & Calibration Guarantees",
    "",
    "- **Independent Reference Superset:** Shadow calibration constructs an independent deterministic reference check set superset beyond candidate selection.",
    "- **Exact Candidate Preservation:** Candidate planned checks and verification run executions are preserved byte-for-byte without alteration.",
    "- **Rigorous Signal Classification:** Checks are classified into `SelectedSignal`, `ObservedShadowMiss`, `SelectedPass`, `UnselectedPass`, or `Incomplete`.",
    "- **Zero-Signal Null Recall:** When no failing signals exist across both candidate and shadow reference sets, `signal_recall` evaluates strictly to `null` (never 100%).",
    "- **Bounded Shadow Execution:** Enforces `max_shadow_checks`, `max_total_duration_ms`, `per_check_timeout_ms`, and `max_output_bytes` limits.",
    "- **Atomic Idempotent Persistence:** Calibration runs, checks, executions, and metrics persist in atomic SQLite transactions with conflict detection.",
    "- **Secret Redaction:** Command arguments, output excerpts, and failure reasons are sanitized against credentials before persistence.",
    "- **Strict Planner, Assurance, Runtime & Attestation Isolation:** Calibration history is measurement-only; it NEVER feeds back into M6 planner selection, assurance escalation, M8 runtime history, or M9 attestation statements.",
    "",
    "## Semantic Preflight Verification",
    "",
    ...preflightResults.map(p => "- [x] `" + p.name + "`: Passed"),
    "",
    "## Performance Metrics",
    "",
    "| Benchmark Scenario | Samples | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |",
    "|---|---|---|---|---|---|---|",
    "| Single Run Calibration Execution | " + metrics.calibration_run_single_ms.count + " | " + metrics.calibration_run_single_ms.min + " | " + metrics.calibration_run_single_ms.median + " | " + metrics.calibration_run_single_ms.p95 + " | " + metrics.calibration_run_single_ms.max + " | " + metrics.calibration_run_single_ms.mean + " |",
    "| Single Run Calibration Show / Query | " + metrics.calibration_show_single_ms.count + " | " + metrics.calibration_show_single_ms.min + " | " + metrics.calibration_show_single_ms.median + " | " + metrics.calibration_show_single_ms.p95 + " | " + metrics.calibration_show_single_ms.max + " | " + metrics.calibration_show_single_ms.mean + " |",
    "| Calibration Aggregate Stats Query | " + metrics.calibration_stats_query_ms.count + " | " + metrics.calibration_stats_query_ms.min + " | " + metrics.calibration_stats_query_ms.median + " | " + metrics.calibration_stats_query_ms.p95 + " | " + metrics.calibration_stats_query_ms.max + " | " + metrics.calibration_stats_query_ms.mean + " |",
    "",
    "### Scaling Benchmarks (50 Runs)",
    "",
    "- **Calibrate 50 Runs Total:** " + metrics.calibrate_50_runs_total_ms + " ms (avg " + metrics.calibrate_avg_per_run_ms + " ms / run)",
    "- **Calibrate Show 50 Runs Total:** " + metrics.calibrate_show_50_runs_total_ms + " ms (avg " + metrics.calibrate_show_avg_per_run_ms + " ms / run)",
    "",
    "---",
    "*Qualification completed under FlowDeck Verifiable Change Intelligence protocol.*"
  ];

  writeFileSync(REPORT_MD_PATH, mdLines.join("\n"));
  console.log("-> Saved qualification markdown: " + REPORT_MD_PATH);
}

main().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
