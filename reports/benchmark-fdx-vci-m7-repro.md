# Milestone 7 Verification Executor Benchmark Report

**Functional Source SHA:** 07e7cd89aa1509285aa3ffdcb2a1574a0a4c5438
**Binary Source SHA:** 07e7cd89aa1509285aa3ffdcb2a1574a0a4c5438
**Binary SHA-256:** 20433bd9b1c43590dedff648f493c3570cd437d0f71ae01184bdb0a3f29ffeb8
**Benchmark Harness SHA:** 756ce9197ed0420c949e8f2196b850adddb22826
**Timestamp:** 2026-08-24T02:35:19.111Z

## Performance Benchmark Timing Table

| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| verify_passing_unit_test_package | 10 | 118.72 | 118.94 | 128.9 | 128.9 | 119.95 |
| verify_failing_unit_test_package | 10 | 118.72 | 118.89 | 129.03 | 129.03 | 119.89 |
| verify_multi_check_package_suite | 10 | 341.2 | 341.61 | 372.35 | 372.35 | 346.61 |
| verify_fail_fast_short_circuit | 10 | 118.76 | 118.9 | 119.25 | 119.25 | 118.96 |
| verify_output_bound_and_redaction | 10 | 118.65 | 119.12 | 129.11 | 129.11 | 121.95 |
| verify_run_persistence_and_retrieval | 10 | 108.68 | 118.95 | 128.94 | 128.94 | 119.3 |
| verify_dirty_worktree_execution | 10 | 118.7 | 119.12 | 139.58 | 139.58 | 122.21 |
