# Milestone 6 Verification Planner Benchmark Report

**Functional Source SHA:** 95a0f143fdc4bdb573f401fd063be9ba55004935
**Binary Source SHA:** 95a0f143fdc4bdb573f401fd063be9ba55004935
**Benchmark Harness SHA:** 4f24959e0e8b0c4bb4bc082b664a57f18598be2d
**Timestamp:** 2026-08-23T08:39:18.315Z

## Performance Benchmark Timing Table

| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| precise_semantic_test_mapping | 10 | 16.45 | 27.93 | 30.57 | 30.57 | 23.67 |
| build_transitive_test_mapping | 10 | 17.18 | 31.35 | 32.63 | 32.63 | 27.69 |
| deleted_symbol_old_current_union | 10 | 14.47 | 15.61 | 17.5 | 17.5 | 15.8 |
| stale_semantic_package_widening | 10 | 28.4 | 28.93 | 30.19 | 30.19 | 29 |
| root_config_workspace_widening | 10 | 30.77 | 30.96 | 35.37 | 35.37 | 31.54 |
| dynamic_test_config_fallback | 10 | 32.44 | 37.73 | 39.31 | 39.31 | 35.78 |
| selected_check_bound_safe_rollup | 10 | 2612.91 | 2900.59 | 4457.29 | 4457.29 | 3140.89 |
| mapping_failure_widens_safely | 10 | 14.74 | 14.89 | 23.32 | 23.32 | 16.04 |
| disconnected_scope_isolation | 10 | 27.5 | 28.69 | 31.47 | 31.47 | 29.01 |
| planner_why_explanation | 10 | 25.27 | 26.28 | 29.66 | 29.66 | 27.14 |
