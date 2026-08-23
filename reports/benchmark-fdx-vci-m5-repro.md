# Milestone 5 Build/Config Graph Federation Benchmark Report

## Provenance

- **Benchmark Name**: `benchmark-fdx-vci-m5-build-config`
- **Timestamp**: `2026-08-23T01:18:18.532Z`
- **Functional Source SHA**: `229fd40cf7c33791d6d75b9a991aed9e92b3cee6`
- **Binary Source SHA**: `229fd40cf7c33791d6d75b9a991aed9e92b3cee6`
- **Benchmark Harness SHA**: `2c0a153586d2438c4af5440e1fbb03f5da45a84d`
- **Platform**: `linux (x64)`

## Performance Results

| Benchmark Scenario | Samples | Median (ms) | P95 (ms) | Min (ms) | Max (ms) | Mean (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `fresh_build_config_aware_impact` | 5 | 102.98 | 150.98 | 102.58 | 150.98 | 117.13 |
| `stale_new_dependency_snapshot_union` | 5 | 47.3 | 75.56 | 25.43 | 75.56 | 46.88 |
| `stale_scope_isolation` | 5 | 69.23 | 69.59 | 68.93 | 69.59 | 69.27 |
| `workspace_root_membership_change` | 5 | 38.68 | 39.11 | 38.44 | 39.11 | 38.75 |
| `bound_safe_widening` | 5 | 96.76 | 97.79 | 96.13 | 97.79 | 96.8 |
| `provider_disappearance` | 5 | 8.5 | 8.64 | 8.42 | 8.64 | 8.52 |
| `provider_detection_failure_preserves_evidence` | 5 | 15.68 | 15.99 | 15.59 | 15.99 | 15.76 |
| `malformed_snapshot_provider_failure` | 5 | 50.62 | 51.9 | 15.13 | 51.9 | 41.26 |
| `malformed_package_local_control` | 5 | 49.31 | 57.42 | 49.08 | 57.42 | 50.9 |
| `why_typed_build_path` | 5 | 64.84 | 65.65 | 64.8 | 65.65 | 65.01 |
