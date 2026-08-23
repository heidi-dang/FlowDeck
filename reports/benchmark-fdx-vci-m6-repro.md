# Milestone 6 Verification Planner Benchmark Report

**Functional Source SHA:** 8b6ebba9b01b1d452229019c9a04f3ab18216049
**Binary Source SHA:** 8b6ebba9b01b1d452229019c9a04f3ab18216049
**Benchmark Harness SHA:** 042d034cb322ac6faa3dde6f9c5f203eb2c37b34
**Timestamp:** 2026-08-23T08:06:12.678Z

## Performance Benchmark Timing Table

| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| precise_semantic_test_mapping | 10 | 13.56 | 14.95 | 27.64 | 27.64 | 16.72 |
| build_transitive_test_mapping | 10 | 66.09 | 66.98 | 69.06 | 69.06 | 67.11 |
| deleted_symbol_old_current_union | 10 | 26.11 | 27.39 | 45.24 | 45.24 | 30.2 |
| stale_semantic_package_widening | 10 | 13.72 | 15.63 | 25.03 | 25.03 | 17.89 |
| root_config_workspace_widening | 10 | 19.41 | 33.22 | 63.95 | 63.95 | 37.12 |
| dynamic_test_config_fallback | 10 | 18.43 | 29.14 | 44.71 | 44.71 | 29.97 |
| mapping_bound_safe_widening | 10 | 22.32 | 28.11 | 56.35 | 56.35 | 35.4 |
| mapping_failure_preserves_last_good | 10 | 37.78 | 40.26 | 41.44 | 41.44 | 40.08 |
| disconnected_scope_isolation | 10 | 23.91 | 28.84 | 44.73 | 44.73 | 32.49 |
| planner_why_explanation | 10 | 31.05 | 31.26 | 31.68 | 31.68 | 31.31 |
