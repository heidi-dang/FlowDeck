# Milestone 10: Shadow Calibration Qualification Report (R29)

**Milestone:** M10  
**Functional Baseline (F26):** `dbee5bb4e558126fb6292cfec043e7bb9fec96df`  
**Binary SHA-256:** `50f3b79891b3840a3ca60389afdca16f2b0afd5cab9f3c8f6012f92a0baba4fb`  
**Benchmark Harness (H29):** `46a0590ddae588ed73d9be19e14cac8995e82c64`  
**Executed At:** 2026-08-24T13:38:51.678Z  
**Platform:** linux (x64)  
**Node Version:** v24.19.0  
**Evidence Graph Schema Version:** `8`  

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

- [x] `schema_v8_tables_and_columns_exist`: Passed
- [x] `v7_to_v8_migration_preserves_runtime_runs`: Passed
- [x] `deterministic_calibration_id_binding`: Passed
- [x] `policy_digest_field_sensitivity`: Passed
- [x] `candidate_plan_exact_preservation`: Passed
- [x] `shadow_reference_superset_discovery`: Passed
- [x] `signal_classification_and_observed_miss_detection`: Passed
- [x] `incomplete_execution_classification`: Passed
- [x] `zero_failing_signals_null_recall`: Passed
- [x] `bounded_shadow_checks_and_truncation`: Passed
- [x] `database_idempotent_persistence`: Passed
- [x] `divergent_data_conflict_rejection`: Passed
- [x] `transaction_rollback_zero_orphaned_rows`: Passed
- [x] `database_reopen_exact_determinism`: Passed
- [x] `privacy_and_secret_redaction`: Passed
- [x] `planner_selection_and_assurance_isolation`: Passed
- [x] `runtime_history_and_executions_isolation`: Passed
- [x] `m9_attestation_statement_and_digest_isolation`: Passed
- [x] `cli_subcommands_end_to_end`: Passed

## Performance Metrics

| Benchmark Scenario | Samples | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|---|---|---|---|---|---|---|
| Single Run Calibration Execution | 15 | 11.18 | 11.65 | 12.72 | 12.72 | 11.68 |
| Single Run Calibration Show / Query | 15 | 5.09 | 5.27 | 5.7 | 5.7 | 5.33 |
| Calibration Aggregate Stats Query | 15 | 4.22 | 4.46 | 4.83 | 4.83 | 4.47 |

### Scaling Benchmarks (50 Runs)

- **Calibrate 50 Runs Total:** 689.53 ms (avg 13.79 ms / run)
- **Calibrate Show 50 Runs Total:** 260.38 ms (avg 5.21 ms / run)

---
*Qualification completed under FlowDeck Verifiable Change Intelligence protocol.*