# Milestone 5 Build/Config Graph Federation Benchmark Report

## Provenance

- **Benchmark Name**: `benchmark-fdx-vci-m5-build-config`
- **Timestamp**: `2026-08-23T02:34:53.129Z`
- **Functional Source SHA**: `6265ffa8c05ccb7cc03c199cce4a276307ea1044`
- **Binary Source SHA**: `6265ffa8c05ccb7cc03c199cce4a276307ea1044`
- **Benchmark Harness SHA**: `05cfaecc9b7e9cc53e63f7d07aeec279d43ca7d4`
- **Platform**: `linux (x64)`

## Performance Results

| Benchmark Scenario | Samples | Median (ms) | P95 (ms) | Min (ms) | Max (ms) | Mean (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `fresh_build_config_aware_impact` | 5 | 84.44 | 86.21 | 65.13 | 86.21 | 77.4 |
| `stale_new_dependency_snapshot_union` | 5 | 76.43 | 78.73 | 76.25 | 78.73 | 76.88 |
| `stale_scope_isolation` | 5 | 69.45 | 69.63 | 69.3 | 69.63 | 69.47 |
| `workspace_root_membership_change` | 5 | 52.87 | 54 | 52.69 | 54 | 53.21 |
| `bound_safe_widening` | 5 | 4689.29 | 4828.58 | 4224.68 | 4828.58 | 4583.07 |
| `provider_disappearance` | 5 | 4.42 | 4.5 | 4.37 | 4.5 | 4.42 |
| `provider_detection_failure_preserves_evidence` | 5 | 9.52 | 9.54 | 8.2 | 9.54 | 9.04 |
| `malformed_snapshot_provider_failure` | 5 | 30.8 | 30.9 | 30.78 | 30.9 | 30.82 |
| `malformed_package_local_control` | 5 | 43.84 | 54.39 | 35.36 | 54.39 | 45.55 |
| `why_typed_build_path` | 5 | 29.48 | 29.9 | 29.41 | 29.9 | 29.56 |
