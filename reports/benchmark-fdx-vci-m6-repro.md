# Milestone 6 Verification Planner Benchmark Report

**Functional Source SHA:** 3101e0ad419d814f336909293a60326b6bae43ee
**Binary Source SHA:** 3101e0ad419d814f336909293a60326b6bae43ee
**Benchmark Harness SHA:** a24bc57e8072812429f24a34ab1c9f7c39393826
**Timestamp:** 2026-08-23T11:24:17.580Z

## Performance Benchmark Timing Table

| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| precise_semantic_test_mapping | 10 | 17.81 | 18.39 | 18.92 | 18.92 | 18.32 |
| build_transitive_test_mapping | 10 | 21.54 | 22.44 | 23.75 | 23.75 | 22.45 |
| deleted_symbol_old_current_union | 10 | 15.8 | 17.19 | 18.68 | 18.68 | 17.07 |
| stale_semantic_package_widening | 10 | 18.27 | 19.91 | 21.54 | 21.54 | 19.83 |
| root_config_workspace_widening | 10 | 17.49 | 18.29 | 21.79 | 21.79 | 18.85 |
| dynamic_test_config_fallback | 10 | 14.74 | 16.78 | 18.6 | 18.6 | 16.51 |
| selected_check_bound_safe_rollup | 10 | 2685.19 | 2776.44 | 2831.98 | 2831.98 | 2761.2 |
| mapping_failure_widens_safely | 10 | 17.25 | 18.15 | 19.58 | 19.58 | 18.46 |
| disconnected_scope_isolation | 10 | 25.13 | 25.51 | 27.32 | 27.32 | 25.76 |
| planner_why_explanation | 10 | 13.55 | 13.85 | 14.18 | 14.18 | 13.85 |
