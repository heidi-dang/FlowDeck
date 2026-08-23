# Milestone 5 Build/Config Graph Federation Benchmark Report

## Provenance

- **Benchmark Name**: `benchmark-fdx-vci-m5-build-config`
- **Timestamp**: `2026-08-23T01:39:58.836Z`
- **Functional Source SHA**: `229fd40cf7c33791d6d75b9a991aed9e92b3cee6`
- **Binary Source SHA**: `229fd40cf7c33791d6d75b9a991aed9e92b3cee6`
- **Benchmark Harness SHA**: `6e8c36ead0ef64d73080db84b33710e7335aaf08`
- **Platform**: `linux (x64)`

## Performance Results

| Benchmark Scenario | Samples | Median (ms) | P95 (ms) | Min (ms) | Max (ms) | Mean (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `fresh_build_config_aware_impact` | 5 | 123.49 | 152.79 | 74.03 | 152.79 | 116.57 |
| `stale_new_dependency_snapshot_union` | 5 | 35.9 | 76.53 | 26.4 | 76.53 | 41.91 |
| `stale_scope_isolation` | 5 | 69.25 | 72.8 | 64.88 | 72.8 | 69.09 |
| `workspace_root_membership_change` | 5 | 52.7 | 52.92 | 52.53 | 52.92 | 52.7 |
| `bound_safe_widening` | 5 | 94.94 | 95.56 | 87.54 | 95.56 | 92.29 |
| `provider_disappearance` | 5 | 14.59 | 14.79 | 14.53 | 14.79 | 14.63 |
| `provider_detection_failure_preserves_evidence` | 5 | 15.76 | 16.55 | 15.44 | 16.55 | 15.85 |
| `malformed_snapshot_provider_failure` | 5 | 51.07 | 51.52 | 50.44 | 51.52 | 51.05 |
| `malformed_package_local_control` | 5 | 58.29 | 58.94 | 57.9 | 58.94 | 58.31 |
| `why_typed_build_path` | 5 | 30.82 | 34.73 | 30.49 | 34.73 | 32.22 |
