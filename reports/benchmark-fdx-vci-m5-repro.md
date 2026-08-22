# Milestone 5 Build/Config Graph Federation Benchmark Report

## Provenance

- **Benchmark Name**: `benchmark-fdx-vci-m5-build-config`
- **Timestamp**: `2026-08-22T16:24:55.383Z`
- **Functional Source SHA**: `71b86b90f2a1ba61f7209cdb943d2ab38451e317`
- **Binary Source SHA**: `71b86b90f2a1ba61f7209cdb943d2ab38451e317`
- **Platform**: `linux (x64)`

## Performance Results

| Benchmark Scenario | Samples | Median (ms) | P95 (ms) | Min (ms) | Max (ms) | Mean (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `package_json_workspace_discovery` | 5 | 8.92 | 10.06 | 8.78 | 10.06 | 9.1 |
| `100_package_workspace_graph` | 5 | 23.38 | 24.32 | 23.23 | 24.32 | 23.58 |
| `1000_package_dependency_edges` | 5 | 41.56 | 42.18 | 41.19 | 42.18 | 41.67 |
| `tsconfig_extends_chain` | 5 | 9.63 | 9.98 | 9.5 | 9.98 | 9.74 |
| `tsconfig_reference_fanout` | 5 | 11 | 11.19 | 10.9 | 11.19 | 11.05 |
| `cargo_workspace_discovery` | 5 | 11.03 | 11.1 | 10.94 | 11.1 | 11.03 |
| `cargo_path_dependency_fanout` | 5 | 11.79 | 12.36 | 11.7 | 12.36 | 11.91 |
| `fresh_build_config_aware_impact` | 5 | 91.39 | 91.89 | 55.04 | 91.89 | 83.57 |
| `stale_scoped_config_widening` | 5 | 19.21 | 19.28 | 19.13 | 19.28 | 19.2 |
| `malformed_package_local_config` | 5 | 32.6 | 32.9 | 32.25 | 32.9 | 32.56 |
| `workspace_root_uncertainty` | 5 | 31.54 | 31.98 | 31.47 | 31.98 | 31.63 |
| `why_explanation_through_build_path` | 5 | 33.62 | 34.67 | 33.27 | 34.67 | 33.73 |
