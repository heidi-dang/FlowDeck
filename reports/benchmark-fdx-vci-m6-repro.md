# Milestone 6 Verification Planner Benchmark Report

**Functional Source SHA:** eef9d801bf43f6df7b086ee9f39e6ff8ae32f407
**Binary Source SHA:** eef9d801bf43f6df7b086ee9f39e6ff8ae32f407
**Benchmark Harness SHA:** c340ed14684631917d83439f38a18138c066118d
**Timestamp:** 2026-08-23T12:16:43.215Z

## Performance Benchmark Timing Table

| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| precise_semantic_test_mapping | 10 | 20.48 | 20.81 | 70.92 | 70.92 | 26.67 |
| build_transitive_test_mapping | 10 | 42.53 | 42.92 | 43.53 | 43.53 | 42.86 |
| deleted_symbol_old_current_union | 10 | 35.77 | 36.21 | 37.03 | 37.03 | 36.29 |
| stale_semantic_package_widening | 10 | 16.75 | 19.25 | 28.99 | 28.99 | 21.47 |
| root_config_workspace_widening | 10 | 16.53 | 17.05 | 18.33 | 18.33 | 17.13 |
| dynamic_test_config_fallback | 10 | 14.51 | 14.92 | 15.91 | 15.91 | 15.06 |
| selected_check_bound_safe_rollup | 10 | 2552.82 | 4174.61 | 5052.31 | 5052.31 | 3993.11 |
| mapping_failure_widens_safely | 10 | 14.5 | 14.67 | 14.93 | 14.93 | 14.69 |
| disconnected_scope_isolation | 10 | 28.88 | 39.19 | 44.25 | 44.25 | 38.42 |
| planner_why_explanation | 10 | 15.62 | 16.81 | 21.1 | 21.1 | 17.28 |
