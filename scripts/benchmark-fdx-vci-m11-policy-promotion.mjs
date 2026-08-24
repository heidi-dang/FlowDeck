#!/usr/bin/env node
/**
 * H34 — M11 final qualification harness.
 *
 * The binary is mandatory external input. This harness never constructs or selects it: callers
 * must supply exact-F31 release provenance through FDX_BENCHMARK_FUNCTIONAL_SHA,
 * FDX_BINARY_PATH, and FDX_BINARY_SHA256. The only emitted artifact is an untracked R33 JSON
 * report; commit separation is enforced by running this at the clean H34 checkout.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { arch, platform, tmpdir } from "node:os";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { resolveRustToolchain } from "./rust-toolchain.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const F31 = "d8f6c1ff4f1cfb34fe47661cba4b07aa934d8568";
const R33_JSON = join(ROOT, "reports", "benchmark-fdx-vci-m11-policy-promotion.json");
const H34_PATH = "scripts/benchmark-fdx-vci-m11-policy-promotion.mjs";
const SAMPLES = 5;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stats(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  const mean = sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length;
  const round = (value) => Number(value.toFixed(2));
  return {
    samples: sorted.length,
    min_ms: round(sorted[0]),
    median_ms: round(sorted[Math.floor(sorted.length / 2)]),
    p95_ms: round(percentile),
    max_ms: round(sorted.at(-1)),
    mean_ms: round(mean),
  };
}

function run(command, args, { cwd = ROOT, env = process.env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (!output.ok && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed: ${output.stderr || output.stdout}`);
  }
  return output;
}

function git(args, options = {}) {
  return run("git", args, options).stdout.trim();
}

function requireCleanCheckout() {
  const status = git(["status", "--porcelain"]);
  if (status) throw new Error(`qualification checkout is not clean: ${status}`);
  const diffCheck = run("git", ["diff", "--check"]);
  if (!diffCheck.ok) throw new Error("qualification checkout fails git diff --check");
}

function validateExternalProvenance(env = process.env) {
  const functionalSha = env.FDX_BENCHMARK_FUNCTIONAL_SHA;
  const binaryPath = env.FDX_BINARY_PATH;
  const suppliedSha = env.FDX_BINARY_SHA256;
  if (!functionalSha || !binaryPath || !suppliedSha) {
    throw new Error("FDX_BENCHMARK_FUNCTIONAL_SHA, FDX_BINARY_PATH, and FDX_BINARY_SHA256 are required");
  }
  if (functionalSha !== F31) {
    throw new Error(`functional source must be exact F31 ${F31}`);
  }
  const segments = normalize(binaryPath).split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase());
  if (segments.includes("debug")) {
    throw new Error("debug binary paths are forbidden for M11 qualification");
  }
  if (!segments.includes("release")) {
    throw new Error("release binary profile is not proven by the supplied binary path");
  }
  if (!existsSync(binaryPath)) throw new Error("supplied external binary does not exist");
  const actualSha = fileSha256(binaryPath);
  if (actualSha !== suppliedSha) throw new Error("supplied external binary SHA-256 does not match actual bytes");
  return {
    functional_source_sha: functionalSha,
    binary_path: binaryPath,
    binary_sha256: actualSha,
    binary_size_bytes: statSync(binaryPath).size,
    binary_profile: "release",
  };
}

function expectRejected(name, fn) {
  try {
    fn();
  } catch {
    return { name, passed: true, command: "in-process provenance rejection" };
  }
  throw new Error(`${name} unexpectedly accepted invalid qualification input`);
}

function plannedCheck() {
  return {
    check_id: "check:pkg:npm:.:format",
    display_name: "format (pkg:npm:.)",
    kind: "format",
    scope: "pkg:npm:.",
    reason: "learned additive policy check for scope pkg:npm:.",
    selection: "policy_widening",
    strength: "structural",
    widening_reason: "learned_policy_add_check",
    mandatory: false,
  };
}

function initializeRepository(prefix) {
  const repo = mkdtempSync(join(tmpdir(), `fdx-m11-${prefix}-`));
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "fdx-m11-benchmark",
      scripts: { test: "true", typecheck: "true", lint: "true", format: "true" },
    }),
  );
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  writeFileSync(join(repo, "src", "value.ts"), "export const value = 1;\n");
  writeFileSync(join(repo, "tests", "value.test.ts"), "export {};\n");
  run("git", ["init"], { cwd: repo });
  run("git", ["config", "user.name", "FDX Benchmark"], { cwd: repo });
  run("git", ["config", "user.email", "benchmark@example.invalid"], { cwd: repo });
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  writeFileSync(join(repo, "src", "value.ts"), "export const value = 2;\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "change"], { cwd: repo });
  return repo;
}

function invokeBinary(binary, repo, args, { allowFailure = false } = {}) {
  return run(binary, args, { cwd: repo, allowFailure });
}

function initializeDatabase(binary, repo) {
  const result = invokeBinary(binary, repo, ["policy", "generate-candidates", "--format", "json"]);
  JSON.parse(result.stdout);
  return join(repo, ".fdx", "index.sqlite");
}

function seedQualifiedCalibrations(dbPath, count, { candidateSelected = false } = {}) {
  const db = new DatabaseSync(dbPath);
  const runInsert = db.prepare(`INSERT INTO calibration_runs (
    calibration_id, source_run_id, candidate_plan_digest, policy_digest, status,
    reference_scope, max_shadow_checks, reference_truncated, started_at_ms,
    completed_at_ms, duration_ms, created_at_ms, calibration_contract_version,
    source_artifact_sha256, record_digest, max_total_duration_ms,
    per_check_timeout_ms, max_output_bytes
  ) VALUES (?, ?, ?, 'measurement-only', 'complete', 'affected', 5, 0, ?, ?, 10, ?, 2, ?, ?, 1000, 100, 4096)`);
  const metricsInsert = db.prepare(`INSERT INTO calibration_metrics (
    calibration_id, candidate_selected_count, shadow_reference_count, shadow_executed_count,
    candidate_physical_execution_count, shadow_physical_execution_count, selected_failure_count,
    unselected_failure_count, observed_shadow_miss_count, shadow_incomplete_count,
    candidate_execution_duration_ms, shadow_reference_duration_ms, selection_ratio,
    runtime_cost_ratio, signal_recall, eligible_for_miss_rate, eligible_for_cost_ratio,
    eligible_for_runtime_comparison
  ) VALUES (?, 1, 2, 1, 1, 1, 1, 1, 1, 0, 10, 20, 0.5, 0.5, 0.5, 1, 1, 1)`);
  const checkInsert = db.prepare(`INSERT INTO calibration_checks (
    calibration_id, check_id, candidate_selected, reference_selected, execution_status,
    has_physical_execution, duration_ms, signal_class, is_observed_shadow_miss, reason,
    display_name, kind, scope, execution_id, reused_execution
  ) VALUES (?, 'check:pkg:npm:.:format', ?, 1, 'failed', 1, 20,
            'observed_shadow_miss', 1, NULL, 'format', 'format', 'pkg:npm:.', NULL, 0)`);
  for (let index = 0; index < count; index += 1) {
    const id = `qualified-${index}`;
    const started = 10_000 + index;
    runInsert.run(id, `run-${id}`, `plan-${id}`, started, started + 10, started, `artifact-${id}`, `record-${id}`);
    metricsInsert.run(id);
    checkInsert.run(id, candidateSelected ? 1 : 0);
  }
  db.close();
}

function seedActivePolicies(dbPath, count) {
  if (count === 0) return;
  seedQualifiedCalibrations(dbPath, 1);
  const db = new DatabaseSync(dbPath);
  const check = plannedCheck();
  const templateJson = canonicalJson(check);
  const templateDigest = sha256(templateJson);
  db.prepare(`INSERT OR IGNORE INTO policy_check_templates (
    template_digest, check_id, planned_check_json, source_calibration_id,
    source_artifact_sha256, source_record_digest, created_at_ms
  ) VALUES (?, ?, ?, 'qualified-0', 'artifact-qualified-0', 'record-qualified-0', 1)`).run(
    templateDigest,
    check.check_id,
    templateJson,
  );
  const candidateInsert = db.prepare(`INSERT INTO policy_candidates (
    candidate_id, candidate_contract_version, trigger_kind, trigger_scope, check_id,
    candidate_digest, promotion_policy_digest, support_count,
    distinct_source_artifact_count, distinct_change_fingerprint_count,
    estimated_added_runtime_ms, state, created_at_ms, updated_at_ms
  ) VALUES (?, 1, 'scope', 'pkg:npm:.', ?, ?, ?, 2, 2, 2, 20, 'eligible', 1, 1)`);
  const evidenceInsert = db.prepare(`INSERT INTO policy_candidate_evidence (
    candidate_id, calibration_id, source_artifact_sha256, candidate_plan_digest,
    calibration_record_digest, check_id, observed_at_ms
  ) VALUES (?, 'qualified-0', 'artifact-qualified-0', 'plan-qualified-0',
            'record-qualified-0', ?, 1)`);
  const policyInsert = db.prepare(`INSERT INTO promoted_policies (
    policy_id, policy_contract_version, candidate_id, action, trigger_kind, trigger_scope,
    check_id, template_digest, candidate_digest, promotion_policy_digest,
    promoted_policy_digest, state, promoted_at_ms, revoked_at_ms, revoke_reason
  ) VALUES (?, 1, ?, 'add_check', 'scope', 'pkg:npm:.', ?, ?, ?, ?, ?, 'promoted', 1, NULL, NULL)`);
  for (let index = 0; index < count; index += 1) {
    const candidateId = `candidate-active-${index}`;
    const candidateDigest = sha256(`candidate-active-${index}`);
    const configDigest = sha256(`promotion-config-active-${index}`);
    const policyId = `policy_${sha256(`${candidateId}:${candidateDigest}:${configDigest}:${templateDigest}`)}`;
    const policyDigest = sha256(`1:${candidateId}:add_check:scope:pkg:npm:.:${check.check_id}:${templateDigest}`);
    candidateInsert.run(candidateId, check.check_id, candidateDigest, configDigest);
    evidenceInsert.run(candidateId, check.check_id);
    policyInsert.run(
      policyId,
      candidateId,
      check.check_id,
      templateDigest,
      candidateDigest,
      configDigest,
      policyDigest,
    );
  }
  db.close();
}

function measure(samples, operation) {
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    operation(index);
    durations.push(performance.now() - started);
  }
  return stats(durations);
}

function benchmarkCandidateGeneration(binary, count) {
  return measure(SAMPLES, () => {
    const repo = initializeRepository(`candidate-${count}`);
    try {
      const dbPath = initializeDatabase(binary, repo);
      seedQualifiedCalibrations(dbPath, count);
      const result = invokeBinary(binary, repo, ["policy", "generate-candidates", "--format", "json"]);
      const candidates = JSON.parse(result.stdout);
      if (!Array.isArray(candidates) || candidates.length !== 1) throw new Error("candidate benchmark did not generate one qualified candidate");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

function benchmarkActiveSnapshot(binary, policyCount) {
  return measure(SAMPLES, () => {
    const repo = initializeRepository(`snapshot-${policyCount}`);
    try {
      const dbPath = initializeDatabase(binary, repo);
      seedActivePolicies(dbPath, policyCount);
      const result = invokeBinary(binary, repo, ["policy", "list-active", "--format", "json"]);
      const payload = JSON.parse(result.stdout);
      if (payload.policies.length !== policyCount) throw new Error("active snapshot policy count mismatch");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

function benchmarkPlan(binary, policyCount, overlay) {
  return measure(SAMPLES, () => {
    const repo = initializeRepository(`plan-${policyCount}-${overlay ? "overlay" : "base"}`);
    try {
      const dbPath = initializeDatabase(binary, repo);
      seedActivePolicies(dbPath, policyCount);
      const args = ["plan", "--base", "HEAD~1", "--head", "HEAD", "--format", "json"];
      if (overlay) args.splice(1, 0, "--policy-overlay");
      const result = invokeBinary(binary, repo, args);
      const payload = JSON.parse(result.stdout);
      if (overlay && !payload.plan) throw new Error("overlay plan benchmark did not return effective plan output");
      if (!overlay && !payload.selected_checks) throw new Error("base plan benchmark did not return M6 plan output");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

function candidateFixture(binary, prefix) {
  const repo = initializeRepository(prefix);
  const dbPath = initializeDatabase(binary, repo);
  seedQualifiedCalibrations(dbPath, 2);
  const generated = invokeBinary(binary, repo, ["policy", "generate-candidates", "--format", "json"]);
  const candidates = JSON.parse(generated.stdout);
  if (candidates.length !== 1) throw new Error("fixture failed to generate a promotable candidate");
  return { repo, candidate: candidates[0] };
}

function benchmarkPromotion(binary) {
  return measure(SAMPLES, () => {
    const { repo, candidate } = candidateFixture(binary, "promotion");
    try {
      const promoted = invokeBinary(binary, repo, ["policy", "promote-candidate", candidate.candidate_id, "--format", "json"]);
      if (!JSON.parse(promoted.stdout).template_digest) throw new Error("promotion benchmark did not persist template binding");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

function benchmarkApplicationPersistence(binary) {
  return measure(SAMPLES, () => {
    const { repo, candidate } = candidateFixture(binary, "application");
    try {
      invokeBinary(binary, repo, ["policy", "promote-candidate", candidate.candidate_id, "--format", "json"]);
      invokeBinary(binary, repo, ["verify", "--policy-overlay", "--base", "HEAD~1", "--head", "HEAD", "--format", "json"]);
      const db = new DatabaseSync(join(repo, ".fdx", "index.sqlite"));
      const count = db.prepare("SELECT count(*) AS count FROM policy_applications").get().count;
      db.close();
      if (count !== 1) throw new Error("application persistence benchmark did not create exactly one audit record");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

function benchmarkQueries(binary) {
  const candidateList = [];
  const candidateShow = [];
  const activeList = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const { repo, candidate } = candidateFixture(binary, "queries");
    try {
      let started = performance.now();
      invokeBinary(binary, repo, ["policy", "list-candidates", "--format", "json"]);
      candidateList.push(performance.now() - started);
      started = performance.now();
      invokeBinary(binary, repo, ["policy", "show-candidate", candidate.candidate_id, "--format", "json"]);
      candidateShow.push(performance.now() - started);
      invokeBinary(binary, repo, ["policy", "promote-candidate", candidate.candidate_id, "--format", "json"]);
      started = performance.now();
      invokeBinary(binary, repo, ["policy", "list-active", "--format", "json"]);
      activeList.push(performance.now() - started);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
  return {
    candidate_list_ms: stats(candidateList),
    candidate_show_ms: stats(candidateShow),
    active_policy_list_ms: stats(activeList),
  };
}

function benchmarkRevocation(binary) {
  return measure(SAMPLES, () => {
    const { repo, candidate } = candidateFixture(binary, "revocation");
    try {
      const promoted = JSON.parse(invokeBinary(binary, repo, ["policy", "promote-candidate", candidate.candidate_id, "--format", "json"]).stdout);
      const revoked = invokeBinary(binary, repo, ["policy", "revoke-policy", promoted.policy_id, "--reason", "benchmark", "--format", "json"]);
      if (JSON.parse(revoked.stdout).state !== "revoked") throw new Error("revocation benchmark did not revoke policy");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

function benchmarkReopen(binary) {
  return measure(SAMPLES, () => {
    const repo = initializeRepository("reopen");
    try {
      const dbPath = initializeDatabase(binary, repo);
      seedActivePolicies(dbPath, 10);
      const payload = JSON.parse(invokeBinary(binary, repo, ["policy", "list-active", "--format", "json"]).stdout);
      if (payload.policies.length !== 10) throw new Error("reopen snapshot benchmark did not load active policies");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

function runBenchmarkSuite(binary) {
  const candidateGeneration = {};
  for (const count of [10, 100, 1000]) candidateGeneration[`${count}_qualified_runs_ms`] = benchmarkCandidateGeneration(binary, count);
  const activeSnapshot = {};
  for (const count of [0, 10, 100]) activeSnapshot[`${count}_active_policies_ms`] = benchmarkActiveSnapshot(binary, count);
  const basePlan = benchmarkPlan(binary, 0, false);
  const emptyOverlay = benchmarkPlan(binary, 0, true);
  const overlay10 = benchmarkPlan(binary, 10, true);
  const overlay100 = benchmarkPlan(binary, 100, true);
  const overhead = (overlay) => ({
    absolute_median_ms: Number((overlay.median_ms - basePlan.median_ms).toFixed(2)),
    percentage_median: Number((((overlay.median_ms - basePlan.median_ms) / basePlan.median_ms) * 100).toFixed(2)),
  });
  return {
    candidate_generation: candidateGeneration,
    active_policy_snapshot: activeSnapshot,
    overlay_planning: {
      base_m6_10_base_checks_equivalent_ms: basePlan,
      empty_overlay_0_active_policies_ms: emptyOverlay,
      overlay_10_base_checks_10_active_policies_ms: overlay10,
      overlay_100_base_checks_100_active_policies_ms: overlay100,
      empty_overlay_overhead: overhead(emptyOverlay),
      active_10_overlay_overhead: overhead(overlay10),
      active_100_overlay_overhead: overhead(overlay100),
    },
    promotion_with_provenance_revalidation_ms: benchmarkPromotion(binary),
    policy_application_persistence_ms: benchmarkApplicationPersistence(binary),
    query_operations: benchmarkQueries(binary),
    explicit_revocation_ms: benchmarkRevocation(binary),
    reopen_active_snapshot_ms: benchmarkReopen(binary),
    comparison_note: "M10 timings are reported separately in benchmark-fdx-vci-m10-shadow-calibration.json; scenarios differ and no direct improvement claim is made.",
  };
}

const semanticTests = [
  ["schema_v10_current", "test_policy_schema", "test_policy_schema_v10_current_contains_additive_policy_tables"],
  ["v9_to_v10_upgrade", "test_policy_schema", "test_v9_to_v10_migration_is_additive_and_preserves_calibration_schema"],
  ["qualified_m10_only", "test_policy_candidate", "test_generate_candidates_uses_only_qualified_current_contract_m10_evidence"],
  ["candidate_run_bounded_lookback", "test_policy_candidate", "test_generate_candidates_lookback_limit_counts_calibration_runs_not_rows"],
  ["policy_selected_evidence_excluded", "test_policy_candidate", "test_generate_candidates_uses_only_qualified_current_contract_m10_evidence"],
  ["self_reinforcement_excluded", "test_policy_candidate", "test_policy_selected_future_observation_cannot_self_reinforce_promoted_support"],
  ["candidate_deterministic_fail_closed_read", "test_policy_candidate", "test_candidate_read_apis_are_stable_and_fail_closed_on_unknown_state"],
  ["promotion_revalidation_and_idempotency", "test_policy_candidate", "test_explicit_promotion_revalidates_evidence_and_revocation_is_idempotent"],
  ["promotion_stale_evidence_rejected", "test_policy_candidate", "test_promotion_fails_when_qualified_evidence_is_changed_after_candidate_generation"],
  ["twenty_connection_promotion", "test_policy_candidate", "test_concurrent_template_bound_promotions_commit_one_policy_and_one_event"],
  ["per_trigger_cap_conflict", "test_policy_candidate", "test_promotion_enforces_per_trigger_additive_cap_without_mutating_second_candidate"],
  ["template_exact_persistence_and_tamper", "test_policy_candidate", "test_promotion_persists_exact_template_and_active_overlay_loading_fails_closed_on_tamper"],
  ["policy_store_corruption_fail_closed", "test_policy_candidate", "test_active_policy_snapshot_fails_closed_for_null_template_unknown_action_and_bad_provenance"],
  ["base_plan_unchanged_affected_scope_addition", "test_policy_overlay", "test_overlay_is_monotonic_and_uses_impacted_scope_even_without_a_base_check"],
  ["unaffected_scope_noop_and_corrupt_template_rejected", "test_policy_overlay", "test_overlay_is_noop_for_unaffected_scope_and_fails_closed_for_missing_template_or_invalid_state"],
  ["policy_application_digest_determinism", "test_policy_overlay", "test_overlay_noop_application_is_deterministic_and_additive"],
  ["duplicate_policy_additions_deduped_snapshot_immutable", "test_policy_overlay", "test_duplicate_policy_additions_are_deduped_and_captured_snapshot_stays_immutable"],
  ["cli_promotion_overlay_application_revocation", "test_policy_cli", "test_policy_cli_promotes_exact_template_preserves_default_plan_and_persists_verify_application"],
  ["m6_direct_path_package_plan", "test_verification_planner", "test_plan_package_source_change_selects_tests_and_typecheck"],
  ["m6_no_manufactured_tests", "test_verification_planner", "test_plan_no_tests_found_does_not_manufacture_tests"],
  ["m6_disconnected_isolation", "test_verification_planner", "test_plan_disconnected_package_isolation"],
  ["m6_root_config_widening", "test_verification_planner", "test_plan_root_tsconfig_change_widens_to_all_ts_projects"],
  ["m6_cargo_workspace", "test_verification_planner", "test_plan_cargo_workspace_crate_change"],
  ["m7_empty_plan_contract", "test_verify_contract", "test_verification_contract_empty_plan_passes"],
  ["m7_lifecycle_contract", "test_verify_contract", "test_verification_contract_lifecycle_and_model"],
  ["m7_duplicate_check_safety", "test_verify_duplicate_checks", "test_duplicate_identical_checks_are_deduped"],
  ["m7_output_bound", "test_verify_output_bounds", "test_output_limit_marks_incomplete"],
  ["m7_path_parent_escape", "test_verify_path_safety", "test_verification_path_safety_rejects_parent_escape"],
  ["m7_path_symlink_escape", "test_verify_path_safety", "test_verification_path_safety_rejects_symlink_escape"],
  ["m7_redaction", "test_verify_redaction", "test_verification_redaction_before_persistence"],
  ["m7_unresolved_obligations", "test_verify_unresolved_obligations", "test_unresolved_obligations_with_zero_checks_is_incomplete"],
  ["m8_runtime_planner_isolation", "test_runtime_planner_isolation", "test_runtime_history_never_alters_planner_selected_checks"],
  ["m8_runtime_idempotency", "test_runtime_idempotency", "test_ingest_same_artifact_is_idempotent"],
  ["m8_runtime_transactionality", "test_runtime_transactionality", "test_runtime_ingest_is_atomic"],
  ["m8_runtime_execution_truth", "test_runtime_physical_execution_truth", "test_runtime_history_preserves_physical_execution_truth"],
  ["m8_runtime_artifact_digest", "test_runtime_exact_artifact_digest", "test_artifact_digest_is_exact_and_idempotent"],
  ["m9_predicate_v1", "test_attestation_predicate", "test_predicate_version_and_uri_constants"],
  ["m9_context_omission", "test_attestation_predicate", "test_source_context_workspace_clean_omitted_when_none"],
  ["m9_plan_binding", "test_attestation_plan_binding", "test_attestation_plan_digest_binding"],
  ["m9_unresolved_binding", "test_attestation_unresolved_binding", "test_attestation_unresolved_obligations_binding"],
  ["m9_statement_determinism", "test_attestation_determinism", "test_attestation_is_deterministic"],
  ["m9_privacy", "test_attestation_privacy", "test_attestation_redacts_private_paths_and_secrets"],
  ["m9_tamper_rejection", "test_attestation_tamper", "test_tampered_attestation_is_rejected"],
  ["m10_candidate_plan_isolation", "test_calibration_candidate_isolation", "test_candidate_plan_is_preserved_exact_and_unchanged"],
  ["m10_planner_isolation", "test_calibration_planner_isolation", "test_calibration_history_never_influences_planner_decisions_or_assurance"],
  ["m10_runtime_isolation", "test_calibration_runtime_isolation", "test_calibration_executions_do_not_pollute_runtime_history"],
  ["m10_attestation_isolation", "test_calibration_attestation_isolation", "test_calibration_does_not_change_attestation_bytes"],
  ["m10_observed_shadow_miss", "test_calibration_observed_miss", "test_observed_shadow_miss_is_recorded"],
  ["m10_physical_execution_truth", "test_calibration_physical_execution_truth", "test_non_physical_statuses_are_never_observed_misses"],
  ["m10_reference_superset", "test_calibration_shadow_execution", "test_shadow_reference_is_superset_of_candidate_plan"],
  ["m10_bounded_duration", "test_calibration_total_budget", "blocking_shadow_process_receives_only_remaining_total_budget"],
  ["m10_atomic_transaction", "test_calibration_transactionality", "test_transaction_rollback_leaves_zero_orphaned_rows_on_error"],
  ["m10_privacy", "test_calibration_privacy", "test_secrets_in_unsupported_reasons_or_environment_are_redacted"],
  ["m10_reopen_determinism", "test_calibration_reopen_determinism", "test_database_close_and_reopen_preserves_exact_metrics"],
  ["protocol_schema_v10", "test_protocol", "test_version_constants"],
  ["protocol_graph_compatibility", "test_protocol", "test_graph_compatibility_defaults"],
  ["protocol_path_canonicalization", "test_protocol", "test_path_canonicalization"],
  ["protocol_path_jail", "test_protocol", "test_path_jail_escaping"],
];

function runPreflights(binary, provenance, headSha, harnessSha) {
  const toolchain = resolveRustToolchain();
  const preflights = [];
  const record = (name, command, fn) => {
    const started = performance.now();
    fn();
    preflights.push({ name, passed: true, command, duration_ms: Number((performance.now() - started).toFixed(2)) });
  };

  record("external_binary_release_profile", "external provenance validation", () => {
    if (provenance.binary_profile !== "release") throw new Error("release profile missing");
  });
  record("external_binary_sha_matches", "sha256 supplied external binary", () => {
    if (fileSha256(provenance.binary_path) !== provenance.binary_sha256) throw new Error("external SHA changed");
  });
  record("binary_source_exact_f31", "FDX_BENCHMARK_FUNCTIONAL_SHA", () => {
    if (provenance.functional_source_sha !== F31) throw new Error("functional source mismatch");
  });
  record("release_binary_executes", `${basename(provenance.binary_path)} --help`, () => {
    invokeBinary(provenance.binary_path, ROOT, ["--help"]);
  });
  record("debug_binary_rejected", "in-process provenance rejection", () => {
    expectRejected("debug binary", () => validateExternalProvenance({ ...process.env, FDX_BINARY_PATH: join(dirname(dirname(provenance.binary_path)), "debug", basename(provenance.binary_path)) }));
  });
  record("wrong_binary_sha_rejected", "in-process provenance rejection", () => {
    expectRejected("wrong binary SHA", () => validateExternalProvenance({ ...process.env, FDX_BINARY_SHA256: "0".repeat(64) }));
  });
  record("wrong_functional_sha_rejected", "in-process provenance rejection", () => {
    expectRejected("wrong functional SHA", () => validateExternalProvenance({ ...process.env, FDX_BENCHMARK_FUNCTIONAL_SHA: "0".repeat(40) }));
  });
  record("qualification_head_owns_h34", "git log harness owner", () => {
    if (headSha !== harnessSha) throw new Error("HEAD is not H34 harness owner");
  });
  record("f31_is_h34_ancestor", "git merge-base --is-ancestor", () => {
    run("git", ["merge-base", "--is-ancestor", F31, headSha]);
  });
  record("no_production_diff_after_f31", "git diff F31..H34 production paths", () => {
    const diff = git(["diff", "--name-only", `${F31}..${headSha}`, "--", "crates/fdx/src", "crates/fdx/Cargo.toml", "Cargo.lock"]);
    if (diff) throw new Error(`production source changed after F31: ${diff}`);
  });
  record("qualification_checkout_clean", "git status and diff --check", requireCleanCheckout);
  record("rust_toolchain_resolver", "scripts/rust-toolchain.mjs", () => {
    if (!toolchain.cargoVersion || !toolchain.rustcVersion) throw new Error("resolver did not return paired toolchain");
  });
  record("policy_cli_help_external_binary", "external policy --help", () => invokeBinary(provenance.binary_path, ROOT, ["policy", "--help"]));
  record("plan_overlay_help_external_binary", "external plan --help", () => invokeBinary(provenance.binary_path, ROOT, ["plan", "--help"]));
  record("verify_overlay_help_external_binary", "external verify --help", () => invokeBinary(provenance.binary_path, ROOT, ["verify", "--help"]));

  for (const [name, testFile, testName] of semanticTests) {
    record(name, `resolved cargo test -p fdx --test ${testFile} ${testName} -- --exact`, () => {
      run(toolchain.cargo, ["test", "-p", "fdx", "--test", testFile, testName, "--", "--exact"], { env: toolchain.env });
    });
  }
  if (preflights.length < 70 || preflights.length > 80) {
    throw new Error(`H34 requires 70–80 meaningful preflights; got ${preflights.length}`);
  }
  return { preflights, toolchain };
}

function main() {
  requireCleanCheckout();
  const provenance = validateExternalProvenance();
  const headSha = git(["rev-parse", "HEAD"]);
  const harnessSha = git(["log", "-1", "--format=%H", "--", H34_PATH]);
  const { preflights, toolchain } = runPreflights(provenance.binary_path, provenance, headSha, harnessSha);
  const benchmarks = runBenchmarkSuite(provenance.binary_path);
  const target = run(toolchain.rustc, ["-vV"], { env: toolchain.env }).stdout.match(/^host: (.+)$/m)?.[1];
  if (!target) throw new Error("unable to determine Rust host target");
  const report = {
    status: "qualified",
    milestone: "M11",
    functional_source_sha: F31,
    binary_source_sha: F31,
    binary_sha256: provenance.binary_sha256,
    binary_profile: "release",
    binary_size_bytes: provenance.binary_size_bytes,
    benchmark_harness_sha: harnessSha,
    qualification_head_sha: headSha,
    schema_version: 10,
    cargo_version: toolchain.cargoVersion,
    rustc_version: toolchain.rustcVersion,
    target,
    platform: platform(),
    arch: arch(),
    external_binary_contract: {
      required_variables: ["FDX_BENCHMARK_FUNCTIONAL_SHA", "FDX_BINARY_PATH", "FDX_BINARY_SHA256"],
      external_binary_autobuild_forbidden: true,
      release_profile_enforced: true,
      supplied_sha_recalculated: true,
    },
    qualification_checkout: {
      clean_before_execution: true,
      f31_ancestor_of_h34: true,
      production_diff_from_f31: [],
      binary_path_recording: "sanitized; release profile and SHA are recorded without an absolute developer path",
    },
    preflight_count: preflights.length,
    preflights,
    benchmarks,
    historical_qualification: {
      h33_r32_final_acceptance: false,
      correction: "H33 auto-built and qualified a debug artifact, embedded generated evidence in the harness commit, used a developer-specific path, and did not execute this M11 performance suite.",
    },
    invariants: [
      "M11 v1 is explicit ADD_CHECK only",
      "candidate generation has no planner authority",
      "base M6 checks, assurance, and unresolved obligations are preserved",
      "policy-selected future observations cannot self-reinforce promotion support",
      "templates and qualified M10 source provenance fail closed on corruption",
      "M6 through M10 remain isolated and M12 production has not started",
    ],
    executed_at: new Date().toISOString(),
  };
  writeFileSync(R33_JSON, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, preflight_count: report.preflight_count, report: relative(ROOT, R33_JSON), binary_sha256: report.binary_sha256 })}\n`);
}

main();
