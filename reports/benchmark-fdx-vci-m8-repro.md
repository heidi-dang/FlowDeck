# Hardened M8 Runtime Evidence & Historical Verification Intelligence Qualification Report (R21)

**Milestone:** M8  
**Functional Commit (F19):** `29828a506e436a9a1d9ca88d8483d4f2d299a0f5`  
**Binary SHA-256:** `6b8c4c84e72506529270b39a2ad9ccd865c414e5ee0fb7ebb0b018144c5d5cb2`  
**Benchmark Harness (H21):** `70c0c9bf1f0bdfe522ff70f0f6f105ef4bf366f4`  
**Executed At:** 2026-08-24T06:56:30.218Z  
**Platform:** linux (x64)  
**Node Version:** v24.19.0  
**Schema Version:** `7`  

## Invariants & Trust Verification

- **Exact Artifact Byte Identity:** Artifact digest is authoritative SHA-256 over exact persisted M7 artifact bytes.
- **Physical Process Execution Truth:** `runtime_executions` strictly contains rows for positively established physical OS process executions (Passed, Failed, TimedOut, OutputLimitExceeded). Synthetic statuses (Unsupported, Skipped, SpawnFailed) are recorded in `runtime_check_observations` with `has_physical_execution = false`.
- **Shared Execution Consistency:** Checks sharing an `execution_id` must have identical command, cwd, status, exit code, duration, and stream digests. Conflicts roll back transactionally.
- **Plan/Check Correspondence:** Unplanned checks are rejected; mandatory flags are never fabricated.
- **Real Multi-Connection Concurrency:** Independent SQLite connections arbitrate run identity atomically inside `BEGIN IMMEDIATE` transactions.
- **Durable Reconciliation Completeness:** `is_complete` persists across database reopen in `runtime_ingestion_state`.
- **Legacy v6 Safe Upgrades:** Existing v6 rows are marked `ingestion_contract_version = 1` (legacy/unqualified) and upgraded to version 2 on exact artifact reconciliation.
- **Planner & Truth Isolation:** M8 runtime observations have zero M6 planner-promotion authority. M8 ingestion failure never alters M7 verification truth.

## Semantic Preflight Verification

- [x] `exact_persisted_artifact_sha_matches_db`: Passed
- [x] `format_only_artifact_mutation_conflicts`: Passed
- [x] `exact_artifact_reimport_is_idempotent`: Passed
- [x] `unsupported_obligation_has_zero_physical_executions`: Passed
- [x] `skipped_obligation_has_zero_physical_executions`: Passed
- [x] `spawn_failed_obligation_has_zero_physical_executions`: Passed
- [x] `shared_execution_is_one_physical_process`: Passed
- [x] `shared_execution_conflicting_command_rejected`: Passed
- [x] `shared_execution_conflicting_status_rejected`: Passed
- [x] `missing_planned_check_rejected`: Passed
- [x] `same_artifact_two_independent_connections`: Passed
- [x] `divergent_artifacts_two_independent_connections`: Passed
- [x] `reconciliation_completeness_persists_after_reopen`: Passed
- [x] `legacy_v6_rows_are_not_silently_qualified`: Passed
- [x] `crash_window_reconciliation`: Passed
- [x] `malformed_artifact_fails_closed`: Passed
- [x] `oversized_artifact_fails_closed`: Passed
- [x] `symlink_artifact_escape_rejected`: Passed
- [x] `planner_selection_unchanged`: Passed
- [x] `M8_failure_does_not_rewrite_M7_truth`: Passed

## Performance Metrics & Database Scaling

| Benchmark | Samples | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|---|---|---|---|---|---|---|
| Single Run Verify + Ingest | 15 | 111.24 | 121.69 | 131.93 | 131.93 | 121.65 |
| Query 50 Runs History | 20 | 2.95 | 3.11 | 3.57 | 3.57 | 3.13 |
| Check Stats & Flake Signal | 20 | 2.92 | 3 | 3.18 | 3.18 | 3.01 |
| Reconcile 50 Artifacts | 15 | 6.9 | 6.98 | 7.04 | 7.04 | 6.96 |

### Database Sizing

- **Initial DB Size (1 Run):** 172032 bytes (168.00 KB)
- **DB Size After 50 Verification Runs:** 208896 bytes (204.00 KB)

---
*Qualification completed under FlowDeck Verifiable Change Intelligence protocol.*