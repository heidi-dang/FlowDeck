# Milestone 7 Verification Executor Benchmark Report

**Functional Source SHA:** 8161d57680697772fcedcfe91893e5cb651c27b7
**Binary Source SHA:** 8161d57680697772fcedcfe91893e5cb651c27b7
**Benchmark Harness SHA:** 8d8caf1057a080c33b6021c25ef19ae1b046e7d2
**Timestamp:** 2026-08-23T13:10:06.644Z

## Performance Benchmark Timing Table

| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| verify_passing_unit_test_package | 10 | 118.44 | 118.71 | 129.17 | 129.17 | 119.74 |
| verify_failing_unit_test_package | 10 | 118.39 | 121.77 | 149.43 | 149.43 | 124.43 |
| verify_multi_check_package_suite | 10 | 341.05 | 341.47 | 351.65 | 351.65 | 343.6 |
| verify_fail_fast_short_circuit | 10 | 108.51 | 119.09 | 129.08 | 129.08 | 121.85 |
| verify_output_bound_and_redaction | 10 | 118.6 | 118.84 | 132.6 | 132.6 | 123.14 |
| verify_run_persistence_and_retrieval | 10 | 118.48 | 118.86 | 128.69 | 128.69 | 120.75 |
| verify_dirty_worktree_execution | 10 | 118.48 | 118.88 | 119.22 | 119.22 | 118.78 |
