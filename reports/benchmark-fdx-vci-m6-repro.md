# Milestone 6 Verification Planner Benchmark Report

**Functional Source SHA:** 300a622ddfe7e36e4f522705268cd389101d4b30
**Binary Source SHA:** 300a622ddfe7e36e4f522705268cd389101d4b30
**Benchmark Harness SHA:** f0f2f36e5b11663bf398afbd4c38bbffb049167d
**Timestamp:** 2026-08-23T10:28:03.133Z

## Performance Benchmark Timing Table

| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| precise_semantic_test_mapping | 10 | 18.11 | 18.43 | 21.38 | 21.38 | 18.73 |
| build_transitive_test_mapping | 10 | 20.75 | 21.47 | 22.04 | 22.04 | 21.43 |
| deleted_symbol_old_current_union | 10 | 14.64 | 15.46 | 16.72 | 16.72 | 15.45 |
| stale_semantic_package_widening | 10 | 17.84 | 18.01 | 20.1 | 20.1 | 18.27 |
| root_config_workspace_widening | 10 | 17.35 | 18.43 | 19.06 | 19.06 | 18.27 |
| dynamic_test_config_fallback | 10 | 14.88 | 15.51 | 19.42 | 19.42 | 15.83 |
| selected_check_bound_safe_rollup | 10 | 2662.07 | 2775.38 | 3098.72 | 3098.72 | 2831.38 |
| mapping_failure_widens_safely | 10 | 15.42 | 19.33 | 22.69 | 22.69 | 18.64 |
| disconnected_scope_isolation | 10 | 24.31 | 25.42 | 27.75 | 27.75 | 25.3 |
| planner_why_explanation | 10 | 12.31 | 13.61 | 14.06 | 14.06 | 13.29 |
