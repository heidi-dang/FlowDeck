# Milestone 7 Verification Executor Benchmark Report

**Functional Source SHA:** be22a7950cace14c319bbf68c85bad00e8fd34c6
**Binary Source SHA:** be22a7950cace14c319bbf68c85bad00e8fd34c6
**Binary SHA-256:** 5bd6200852724acf6055e7bc36730a443c1bec475dcf648fbfaa2a804f0f20f7
**Benchmark Harness SHA:** 00f5802d967a4d8149399946f671446e0700109e
**Timestamp:** 2026-08-23T15:06:52.549Z

## Performance Benchmark Timing Table

| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| verify_passing_unit_test_package | 10 | 118.68 | 118.89 | 123.27 | 123.27 | 119.29 |
| verify_failing_unit_test_package | 10 | 118.75 | 118.92 | 119.21 | 119.21 | 118.95 |
| verify_multi_check_package_suite | 10 | 341.34 | 341.83 | 361.84 | 361.84 | 346.69 |
| verify_fail_fast_short_circuit | 10 | 118.61 | 118.84 | 119.21 | 119.21 | 118.85 |
| verify_output_bound_and_redaction | 10 | 118.68 | 119.43 | 129.07 | 129.07 | 122.97 |
| verify_run_persistence_and_retrieval | 10 | 118.8 | 119.01 | 179.71 | 179.71 | 125.1 |
| verify_dirty_worktree_execution | 10 | 118.51 | 118.91 | 119.78 | 119.78 | 118.93 |
