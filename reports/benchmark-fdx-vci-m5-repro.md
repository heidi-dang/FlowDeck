# Milestone 5 Build/Config Graph Federation Benchmark Report

## Provenance

- **Benchmark Name**: `benchmark-fdx-vci-m5-build-config`
- **Timestamp**: `2026-08-23T03:22:42.105Z`
- **Functional Source SHA**: `9c1a9b693f5e17aba3b8e7203807d72f274fbaae`
- **Binary Source SHA**: `9c1a9b693f5e17aba3b8e7203807d72f274fbaae`
- **Benchmark Harness SHA**: `3a0ce7fb9c3b0080298136b1a278f8e23ba216f6`
- **Platform**: `linux (x64)`

## Performance Results

| Benchmark Scenario | Samples | Median (ms) | P95 (ms) | Min (ms) | Max (ms) | Mean (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `fresh_build_config_aware_impact` | 5 | 87.03 | 125.58 | 63 | 125.58 | 91.68 |
| `stale_new_dependency_snapshot_union` | 5 | 32.4 | 78.3 | 26.22 | 78.3 | 48.95 |
| `stale_scope_isolation` | 5 | 69.52 | 75.36 | 58.6 | 75.36 | 67.68 |
| `workspace_root_membership_change` | 5 | 53.13 | 54 | 52.88 | 54 | 53.31 |
| `bound_safe_widening` | 5 | 4804.3 | 4879.02 | 4442.15 | 4879.02 | 4757.01 |
| `provider_disappearance` | 5 | 4.87 | 5 | 4.82 | 5 | 4.89 |
| `provider_ingest_failure_preserves_evidence` | 5 | 11.75 | 13.39 | 10.02 | 13.39 | 11.73 |
| `malformed_snapshot_provider_failure` | 5 | 53.27 | 53.72 | 52.54 | 53.72 | 53.24 |
| `malformed_package_local_control` | 5 | 26.67 | 26.78 | 19.45 | 26.78 | 25.13 |
| `why_typed_build_path` | 5 | 55.36 | 55.85 | 30.36 | 55.85 | 49.87 |
