# Milestone 5 Build/Config Graph Federation Benchmark Report

## Provenance

- **Benchmark Name**: `benchmark-fdx-vci-m5-build-config`
- **Timestamp**: `2026-08-23T03:02:12.623Z`
- **Functional Source SHA**: `9c1a9b693f5e17aba3b8e7203807d72f274fbaae`
- **Binary Source SHA**: `9c1a9b693f5e17aba3b8e7203807d72f274fbaae`
- **Benchmark Harness SHA**: `dd0333eaa66820d6fb97d3d15cde1e8dc49d6a33`
- **Platform**: `linux (x64)`

## Performance Results

| Benchmark Scenario | Samples | Median (ms) | P95 (ms) | Min (ms) | Max (ms) | Mean (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `fresh_build_config_aware_impact` | 5 | 59.33 | 134.5 | 58.6 | 134.5 | 75.96 |
| `stale_new_dependency_snapshot_union` | 5 | 76.3 | 79.68 | 24.51 | 79.68 | 58.14 |
| `stale_scope_isolation` | 5 | 69.93 | 70.04 | 69.38 | 70.04 | 69.82 |
| `workspace_root_membership_change` | 5 | 54.92 | 56.53 | 53.35 | 56.53 | 54.92 |
| `bound_safe_widening` | 5 | 4352.23 | 4552.99 | 3246.08 | 4552.99 | 4058.26 |
| `provider_disappearance` | 5 | 4.68 | 4.72 | 4.62 | 4.72 | 4.68 |
| `provider_detection_failure_preserves_evidence` | 5 | 7.25 | 7.35 | 7.22 | 7.35 | 7.27 |
| `malformed_snapshot_provider_failure` | 5 | 23.49 | 24.23 | 23.47 | 24.23 | 23.63 |
| `malformed_package_local_control` | 5 | 43.2 | 50.2 | 29.96 | 50.2 | 41.88 |
| `why_typed_build_path` | 5 | 65.83 | 66.53 | 63.41 | 66.53 | 65.44 |
