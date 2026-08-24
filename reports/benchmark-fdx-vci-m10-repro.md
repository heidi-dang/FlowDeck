# Milestone 10: Hardened Shadow Calibration Qualification Report (R31)

**Status:** `qualified`
**Milestone:** M10
**Functional Baseline (F29):** `f7461acb366fb584a8927668f752e4f7bf8c9dbb`
**Binary SHA-256:** `c95fcfba1c59f107e4b6117ce2248a9d0e3011d477fb0d81312afba3f9046b3d`
**Benchmark Harness (H32):** `d802bfb89af107f5e5ff9e1911eb81f85f02d4fd`
**Executed At:** 2026-08-24T15:47:17.990Z
**Platform:** linux (x64)
**Node Version:** v22.13.0
**Evidence Graph Schema Version:** `9`

## Invariants & Calibration Guarantees

- **Independent Reference Superset:** Shadow calibration constructs an independent deterministic reference check set superset beyond candidate selection.
- **Exact Candidate Preservation:** Candidate planned checks and verification run executions are preserved byte-for-byte without alteration.
- **Rigorous Signal Classification:** Checks are classified into `SelectedSignal`, `ObservedShadowMiss`, `SelectedPass`, `UnselectedPass`, or `Incomplete`.
- **Zero-Signal Null Recall:** When no failing signals exist across both candidate and shadow reference sets, `signal_recall` evaluates strictly to `null` (never 100%).
- **Bounded Shadow Execution:** Enforces `max_shadow_checks`, `max_total_duration_ms`, `per_check_timeout_ms`, and `max_output_bytes` limits.
- **Atomic Idempotent Persistence:** Calibration runs, checks, executions, and metrics persist in atomic SQLite transactions with conflict detection.
- **Secret Redaction:** Command arguments, output excerpts, and failure reasons are sanitized against credentials before persistence.
- **Strict Planner, Assurance, Runtime & Attestation Isolation:** Calibration history is measurement-only; it NEVER feeds back into M6 planner selection, assurance escalation, M8 runtime history, or M9 attestation statements.

## Semantic Preflight Verification

- [x] `schema_v9_current`: Passed
- [x] `v8_to_v9_upgrade`: Passed
- [x] `legacy_v8_row_unqualified`: Passed
- [x] `candidate_plan_unchanged`: Passed
- [x] `candidate_superset_low_limit`: Passed
- [x] `candidate_count_above_shadow_limit`: Passed
- [x] `additional_shadow_budget_zero`: Passed
- [x] `additional_shadow_budget_bounded`: Passed
- [x] `candidate_unsupported_nonphysical`: Passed
- [x] `candidate_skipped_nonphysical`: Passed
- [x] `candidate_spawnfailed_nonphysical`: Passed
- [x] `shared_candidate_execution_deduplicated`: Passed
- [x] `shared_candidate_duration_deduplicated`: Passed
- [x] `shared_shadow_execution_deduplicated`: Passed
- [x] `shared_shadow_duration_deduplicated`: Passed
- [x] `strict_total_duration_budget`: Passed
- [x] `observed_shadow_miss`: Passed
- [x] `unselected_pass_not_false_negative`: Passed
- [x] `incomplete_recall_null`: Passed
- [x] `truncated_recall_null`: Passed
- [x] `zero_signal_recall_null`: Passed
- [x] `known_signal_recall_50_percent`: Passed
- [x] `aggregate_recall_eligibility`: Passed
- [x] `aggregate_cost_eligibility`: Passed
- [x] `record_digest_deterministic`: Passed
- [x] `same_record_idempotent`: Passed
- [x] `changed_check_conflict`: Passed
- [x] `changed_execution_conflict`: Passed
- [x] `changed_metrics_conflict`: Passed
- [x] `qualified_existing_record_no_rerun`: Passed
- [x] `source_artifact_sha_bound`: Passed
- [x] `query_display_name_exact`: Passed
- [x] `query_kind_exact`: Passed
- [x] `query_scope_exact`: Passed
- [x] `corrupt_status_rejected`: Passed
- [x] `corrupt_kind_rejected`: Passed
- [x] `candidate_reason_secret_redacted`: Passed
- [x] `shadow_reason_secret_redacted`: Passed
- [x] `absolute_cwd_not_persisted`: Passed
- [x] `absolute_program_path_not_persisted`: Passed
- [x] `git_colored_diff_does_not_break_change_detection`: Passed
- [x] `planner_selection_unchanged`: Passed
- [x] `planner_assurance_unchanged`: Passed
- [x] `M7_unchanged`: Passed
- [x] `M8_unpolluted`: Passed
- [x] `M9_attestation_bytes_unchanged`: Passed
- [x] `offline_execution`: Passed

## Performance Metrics

| Benchmark Scenario | Samples | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|---|---|---|---|---|---|---|
| Single Run Calibration Execution | 15 | 9.98 | 10.85 | 12.27 | 12.27 | 11.06 |
| Single Run Calibration Show / Query | 15 | 4.88 | 5.18 | 6.1 | 6.1 | 5.27 |
| Calibration Aggregate Stats Query | 15 | 4.38 | 5.22 | 6.19 | 6.19 | 5.24 |

### Scaling Benchmarks (50 Runs)

- **Calibrate 50 Runs Total:** 632.46 ms (avg 12.65 ms / run)
- **Calibrate Show 50 Runs Total:** 250.85 ms (avg 5.02 ms / run)

---
*Qualification completed under FlowDeck Verifiable Change Intelligence protocol.*