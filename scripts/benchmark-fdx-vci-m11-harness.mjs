#!/usr/bin/env node
/**
 * H33 — M11 qualified learned-policy overlay verification harness.
 *
 * This intentionally accepts only the exact F31 source commit. It runs named, real cargo/CLI
 * preflights and emits content suitable for an R32 qualification report. It has no M12 action.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const expectedCommit = "d8f6c1ff4f1cfb34fe47661cba4b07aa934d8568";
const reportPath = resolve(repoRoot, "reports/benchmark-fdx-vci-m11-harness.json");
const cargo = process.env.CARGO ?? "cargo";

function run(command, args, { capture = true } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: `/home/ubuntu/.cargo/bin:${process.env.PATH ?? ""}` },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: capture ? result.stdout ?? "" : "",
    stderr: capture ? result.stderr ?? "" : "",
  };
}

const singleTests = [
  ["m11_candidate_qualified_only", "test_policy_candidate", "test_generate_candidates_uses_only_qualified_current_contract_m10_evidence"],
  ["m11_candidate_run_bounded_lookback", "test_policy_candidate", "test_generate_candidates_lookback_limit_counts_calibration_runs_not_rows"],
  ["m11_candidate_read_fail_closed", "test_policy_candidate", "test_candidate_read_apis_are_stable_and_fail_closed_on_unknown_state"],
  ["m11_promotion_revalidation_idempotence", "test_policy_candidate", "test_explicit_promotion_revalidates_evidence_and_revocation_is_idempotent"],
  ["m11_promotion_stale_evidence_rejected", "test_policy_candidate", "test_promotion_fails_when_qualified_evidence_is_changed_after_candidate_generation"],
  ["m11_template_persistence_tamper_rejected", "test_policy_candidate", "test_promotion_persists_exact_template_and_active_overlay_loading_fails_closed_on_tamper"],
  ["m11_snapshot_null_unknown_provenance_rejected", "test_policy_candidate", "test_active_policy_snapshot_fails_closed_for_null_template_unknown_action_and_bad_provenance"],
  ["m11_promotion_concurrency_twenty_connections", "test_policy_candidate", "test_concurrent_template_bound_promotions_commit_one_policy_and_one_event"],
  ["m11_trigger_cap_conflict", "test_policy_candidate", "test_promotion_enforces_per_trigger_additive_cap_without_mutating_second_candidate"],
  ["m11_overlay_monotonic_impacted_scope", "test_policy_overlay", "test_overlay_is_monotonic_and_uses_impacted_scope_even_without_a_base_check"],
  ["m11_overlay_missing_template_invalid_state_rejected", "test_policy_overlay", "test_overlay_is_noop_for_unaffected_scope_and_fails_closed_for_missing_template_or_invalid_state"],
  ["m11_overlay_noop_application_deterministic", "test_policy_overlay", "test_overlay_noop_application_is_deterministic_and_additive"],
  ["m11_cli_promote_overlay_verify_revoke", "test_policy_cli", "test_policy_cli_promotes_exact_template_preserves_default_plan_and_persists_verify_application"],
  ["m11_schema_v10_policy_tables", "test_policy_schema", "test_policy_schema_v10_current_contains_additive_policy_tables"],
  ["m11_schema_v9_to_v10_additive", "test_policy_schema", "test_v9_to_v10_migration_is_additive_and_preserves_calibration_schema"],
  ["m6_package_source_plan", "test_verification_planner", "test_plan_package_source_change_selects_tests_and_typecheck"],
  ["m6_no_manufactured_tests", "test_verification_planner", "test_plan_no_tests_found_does_not_manufacture_tests"],
  ["m6_disconnected_package_isolation", "test_verification_planner", "test_plan_disconnected_package_isolation"],
  ["m6_root_config_widening", "test_verification_planner", "test_plan_root_tsconfig_change_widens_to_all_ts_projects"],
  ["m6_cargo_workspace_plan", "test_verification_planner", "test_plan_cargo_workspace_crate_change"],
  ["m7_empty_plan_contract", "test_verify_contract", "test_verification_contract_empty_plan_passes"],
  ["m7_verification_lifecycle_contract", "test_verify_contract", "test_verification_contract_lifecycle_and_model"],
  ["m7_duplicate_check_safety", "test_verify_duplicate_checks", "test_duplicate_identical_checks_are_deduped"],
  ["m7_output_bound_safety", "test_verify_output_bounds", "test_output_limit_marks_incomplete"],
  ["m7_path_jail_parent_escape", "test_verify_path_safety", "test_verification_path_safety_rejects_parent_escape"],
  ["m7_path_jail_symlink_escape", "test_verify_path_safety", "test_verification_path_safety_rejects_symlink_escape"],
  ["m7_redaction_before_persistence", "test_verify_redaction", "test_verification_redaction_before_persistence"],
  ["m7_unresolved_zero_checks", "test_verify_unresolved_obligations", "test_unresolved_obligations_with_zero_checks_is_incomplete"],
  ["m8_runtime_planner_isolation", "test_runtime_planner_isolation", "test_runtime_history_never_alters_planner_selected_checks"],
  ["m8_runtime_idempotency", "test_runtime_idempotency", "test_ingest_same_artifact_is_idempotent"],
  ["m8_runtime_atomicity", "test_runtime_transactionality", "test_runtime_ingest_is_atomic"],
  ["m8_runtime_execution_truth", "test_runtime_physical_execution_truth", "test_runtime_history_preserves_physical_execution_truth"],
  ["m8_runtime_artifact_digest", "test_runtime_exact_artifact_digest", "test_artifact_digest_is_exact_and_idempotent"],
  ["m9_predicate_version", "test_attestation_predicate", "test_predicate_version_and_uri_constants"],
  ["m9_predicate_context_omission", "test_attestation_predicate", "test_source_context_workspace_clean_omitted_when_none"],
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
  ["protocol_schema_version", "test_protocol", "test_version_constants"],
  ["protocol_graph_compatibility", "test_protocol", "test_graph_compatibility_defaults"],
  ["protocol_path_canonicalization", "test_protocol", "test_path_canonicalization"],
  ["protocol_path_jail", "test_protocol", "test_path_jail_escaping"],
];

const commandPreflights = [
  ["f31_commit_identity", "git", ["rev-parse", "HEAD"]],
  ["f31_parent_is_f30", "git", ["rev-parse", "HEAD^"]],
  ["working_tree_source_clean", "git", ["diff", "--check", "HEAD"]],
  ["rust_format", cargo, ["fmt", "--all", "--", "--check"]],
  ["rust_clippy", cargo, ["clippy", "-p", "fdx", "--all-targets", "--", "-D", "warnings"]],
  ["fdx_build", cargo, ["build", "-p", "fdx"]],
  ["policy_cli_help", cargo, ["run", "-q", "-p", "fdx", "--", "policy", "--help"]],
  ["plan_overlay_cli_help", cargo, ["run", "-q", "-p", "fdx", "--", "plan", "--help"]],
  ["verify_overlay_cli_help", cargo, ["run", "-q", "-p", "fdx", "--", "verify", "--help"]],
];

const startedAt = new Date().toISOString();
const preflights = [];
const head = run("git", ["rev-parse", "HEAD"]);
if (!head.ok || head.stdout.trim() !== expectedCommit) {
  throw new Error(`H33 must run at exact F31 ${expectedCommit}; found ${head.stdout.trim() || "unavailable"}`);
}

for (const [name, command, args] of commandPreflights) {
  const started = Date.now();
  const result = run(command, args);
  const semanticCheck = name === "f31_commit_identity"
    ? result.stdout.trim() === expectedCommit
    : name === "f31_parent_is_f30"
      ? result.stdout.trim() === "7d4299c69a7f8412507f64f4bae16ccf4064ee79"
      : true;
  preflights.push({ name, command: [command, ...args], passed: result.ok && semanticCheck, duration_ms: Date.now() - started });
  if (!result.ok || !semanticCheck) throw new Error(`${name} failed: ${result.stderr || result.stdout}`);
}

for (const [name, testFile, testName] of singleTests) {
  const started = Date.now();
  const result = run(cargo, ["test", "-p", "fdx", "--test", testFile, testName, "--", "--exact"]);
  preflights.push({ name, command: [cargo, "test", "-p", "fdx", "--test", testFile, testName, "--", "--exact"], passed: result.ok, duration_ms: Date.now() - started });
  if (!result.ok) throw new Error(`${name} failed: ${result.stderr || result.stdout}`);
}

const binaryPath = resolve(repoRoot, "target/debug/fdx");
if (!existsSync(binaryPath)) throw new Error("fdx binary was not built");
const binarySha256 = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
const report = {
  harness: "H33",
  status: "passed",
  milestone: "M11",
  source_commit: expectedCommit,
  source_parent: "7d4299c69a7f8412507f64f4bae16ccf4064ee79",
  binary: { path: "target/debug/fdx", sha256: binarySha256 },
  executed_at: startedAt,
  completed_at: new Date().toISOString(),
  preflight_count: preflights.length,
  preflights,
  invariants: [
    "qualified M10 non-policy observed-shadow-miss evidence only",
    "explicit template-bound ADD_CHECK promotion only",
    "M6 checks, assurance, and unresolved obligations are preserved",
    "persisted template, policy identity, and source provenance are verified fail-closed",
    "default M6/M7/M8/M9/M10 behavior remains isolated",
    "no M12 production, merge, or release authority",
  ],
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ harness: report.harness, status: report.status, preflight_count: report.preflight_count, binary_sha256: binarySha256, report: "reports/benchmark-fdx-vci-m11-harness.json" }));
