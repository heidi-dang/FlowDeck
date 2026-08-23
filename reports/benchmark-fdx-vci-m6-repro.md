# Milestone 6 Verification Planner Benchmark Report

**Functional Source SHA:** 3a530035b08db7d0767a95df88063e910c37fb94
**Binary Source SHA:** 3a530035b08db7d0767a95df88063e910c37fb94
**Benchmark Harness SHA:** 3f144241ea42619278a059c80b009d1c55f1d5d0
**Timestamp:** 2026-08-23T09:46:24.104Z

## Performance Benchmark Timing Table

| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| precise_semantic_test_mapping | 10 | 19.02 | 19.66 | 20.92 | 20.92 | 19.71 |
| build_transitive_test_mapping | 10 | 22.88 | 24.17 | 25.11 | 25.11 | 23.91 |
| deleted_symbol_old_current_union | 10 | 16.35 | 16.97 | 19.53 | 19.53 | 17.21 |
| stale_semantic_package_widening | 10 | 18.18 | 19.27 | 20.04 | 20.04 | 19.16 |
| root_config_workspace_widening | 10 | 18.62 | 21.58 | 26.17 | 26.17 | 21.57 |
| dynamic_test_config_fallback | 10 | 15.45 | 16.24 | 18.42 | 18.42 | 16.34 |
| selected_check_bound_safe_rollup | 10 | 2724.33 | 2786.44 | 2937.84 | 2937.84 | 2797.85 |
| mapping_failure_widens_safely | 10 | 16.39 | 17.06 | 17.9 | 17.9 | 17.06 |
| disconnected_scope_isolation | 10 | 25.19 | 26.08 | 26.82 | 26.82 | 25.98 |
| planner_why_explanation | 10 | 13.2 | 13.67 | 14.31 | 14.31 | 13.64 |
