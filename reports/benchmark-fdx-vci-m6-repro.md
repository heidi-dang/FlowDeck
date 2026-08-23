# Milestone 6 Verification Planner Benchmark Report

**Functional Source SHA:** f151a9de7fb1776b705d04c5fdcda2662c51f238
**Binary Source SHA:** f151a9de7fb1776b705d04c5fdcda2662c51f238
**Benchmark Harness SHA:** 2e5cfe8e19742e8e99ca20414740396087129f79
**Timestamp:** 2026-08-23T04:15:05.319Z

## Performance Benchmark Timing Table

| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| precise_semantic_test_mapping | 10 | 16.53 | 18.96 | 19.09 | 19.09 | 18.47 |
| build_transitive_test_mapping | 10 | 57.96 | 63.15 | 63.7 | 63.7 | 60.98 |
| deleted_symbol_old_current_union | 10 | 49.69 | 50.05 | 51.14 | 51.14 | 50.11 |
| stale_semantic_package_widening | 10 | 56.99 | 57.23 | 59.08 | 59.08 | 57.4 |
| root_config_workspace_widening | 10 | 18.43 | 63.71 | 64.49 | 64.49 | 46.96 |
| dynamic_test_config_fallback | 10 | 32.49 | 57.18 | 57.99 | 57.99 | 47.67 |
| mapping_bound_safe_widening | 10 | 65.31 | 70.92 | 72.08 | 72.08 | 69.4 |
| mapping_failure_preserves_last_good | 10 | 49.8 | 50.31 | 51.53 | 51.53 | 50.52 |
| disconnected_scope_isolation | 10 | 63.28 | 69.29 | 70.04 | 70.04 | 68.32 |
| planner_why_explanation | 10 | 14.48 | 50.17 | 51.29 | 51.29 | 42.21 |
