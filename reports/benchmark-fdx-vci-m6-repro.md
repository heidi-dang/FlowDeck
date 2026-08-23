# Milestone 6 Verification Planner Benchmark Report

**Functional Source SHA:** 3385212921b40d9cc3f56173d723b06191afba83
**Binary Source SHA:** 3385212921b40d9cc3f56173d723b06191afba83
**Benchmark Harness SHA:** c59a2e13aba0be6324c0ee76b32f8c1c1be2e4e9
**Timestamp:** 2026-08-23T09:10:51.401Z

## Performance Benchmark Timing Table

| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| precise_semantic_test_mapping | 10 | 22.63 | 23.35 | 25.26 | 25.26 | 23.54 |
| build_transitive_test_mapping | 10 | 17.02 | 23.03 | 24.09 | 24.09 | 21.38 |
| deleted_symbol_old_current_union | 10 | 16.41 | 17.43 | 19.46 | 19.46 | 17.46 |
| stale_semantic_package_widening | 10 | 16.36 | 16.73 | 23.97 | 23.97 | 17.91 |
| root_config_workspace_widening | 10 | 18.85 | 35.5 | 39.2 | 39.2 | 31.86 |
| dynamic_test_config_fallback | 10 | 13.72 | 14.97 | 16.87 | 16.87 | 14.92 |
| selected_check_bound_safe_rollup | 10 | 2674.33 | 2812.08 | 3467.86 | 3467.86 | 2865.39 |
| mapping_failure_widens_safely | 10 | 14.97 | 15.47 | 15.7 | 15.7 | 15.41 |
| disconnected_scope_isolation | 10 | 23.47 | 29.97 | 30.8 | 30.8 | 27.95 |
| planner_why_explanation | 10 | 27.33 | 29.54 | 29.8 | 29.8 | 29.27 |
