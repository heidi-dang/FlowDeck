# M8 Runtime Evidence & Historical Verification Intelligence Benchmark Reproduction Report

**Milestone:** M8  
**Functional Commit (F18):** `56e986b72421d8b4e5186f65cf3a3f31d67b42cf`  
**Executed At:** 2026-08-24T03:17:09.539Z  
**Platform:** linux (x64)  
**Node Version:** v24.19.0  

## Invariants & Safety Verification

- **Schema Version:** SQLite Schema Version 6 (runtime tables: `runtime_runs`, `runtime_executions`, `runtime_check_observations`, `runtime_change_observations`, `runtime_ingestion_state`)
- **Atomic Ingestion:** Transactional all-or-nothing insertion with complete SHA-256 artifact digest verification.
- **Idempotency & Conflicts:** Idempotent re-ingestion for identical artifacts; non-destructive Conflict reporting on divergent digests.
- **Execution Deduplication:** Multi-obligation check runs map cleanly to unique process executions without duration inflation.
- **Reconciliation Bounds:** Safe `.fdx/runs/*.json` discovery with path containment, symlink escape rejection, and 16MB file size caps.
- **Flake Signal & State Separation:** Transition-based flake signals with strict separation of real test failures from infrastructure/incomplete states.
- **Planner Invariance:** Milestone 6 test selection remains 100% frozen; runtime observations never alter semantic test selection.

## Performance Results

| Benchmark Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) |
|---|---|---|---|---|---|
| Single Run Verify + Ingestion | 15 | 135.2 | 135.84 | 148.68 | 148.68 |
| History Runs Query (50 runs) | 20 | 5.36 | 5.63 | 5.98 | 5.98 |
| Check Stats & Flake Query | 20 | 4.64 | 4.75 | 4.98 | 4.98 |
| History Reconcile (50 artifacts) | 15 | 38.98 | 39.45 | 40.59 | 40.59 |

## Reproduction Steps

```bash
cargo build -p fdx
node scripts/benchmark-fdx-vci-m8-runtime-history.mjs
```
