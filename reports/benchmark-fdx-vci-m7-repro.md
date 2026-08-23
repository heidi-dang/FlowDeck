# Milestone 7 Verification Executor Benchmark Report

**Functional Source SHA:** b729679a945f2a217a4eebd28a5d82c6e75d579e
**Binary Source SHA:** b729679a945f2a217a4eebd28a5d82c6e75d579e
**Binary SHA-256:** d6a05a0fe209444f2ed1f981b978bf019e1075a60ac5d51f60fe8e7730cc5ebb
**Benchmark Harness SHA:** 03d9e6e4d52b81bc7a238786d34e2666de9d09af
**Timestamp:** 2026-08-23T14:12:22.885Z

## Performance Benchmark Timing Table

| Scenario | Count | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| verify_passing_unit_test_package | 10 | 119.09 | 120.14 | 130.56 | 130.56 | 123.64 |
| verify_failing_unit_test_package | 10 | 119.19 | 119.45 | 129.56 | 129.56 | 121.4 |
| verify_multi_check_package_suite | 10 | 342.01 | 342.15 | 352.18 | 352.18 | 346.07 |
| verify_fail_fast_short_circuit | 10 | 119.22 | 119.3 | 129.75 | 129.75 | 121.48 |
| verify_output_bound_and_redaction | 10 | 119.23 | 119.92 | 129.92 | 129.92 | 123.45 |
| verify_run_persistence_and_retrieval | 10 | 119.2 | 119.28 | 122.99 | 122.99 | 119.78 |
| verify_dirty_worktree_execution | 10 | 119.16 | 119.45 | 129.34 | 129.34 | 120.37 |
