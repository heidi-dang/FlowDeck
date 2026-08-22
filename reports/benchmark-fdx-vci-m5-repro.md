# Milestone 5 Build/Config Graph Federation Benchmark Report

## Provenance

- **Benchmark Name**: `benchmark-fdx-vci-m5-build-config`
- **Timestamp**: `2026-08-22T16:26:20.307Z`
- **Functional Source SHA**: `71b86b90f2a1ba61f7209cdb943d2ab38451e317`
- **Binary Source SHA**: `71b86b90f2a1ba61f7209cdb943d2ab38451e317`
- **Platform**: `linux (x64)`

## Performance Results

| Benchmark Scenario | Samples | Median (ms) | P95 (ms) | Min (ms) | Max (ms) | Mean (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `package_json_workspace_discovery` | 5 | 9.1 | 9.38 | 8.61 | 9.38 | 9 |
| `100_package_workspace_graph` | 5 | 23.18 | 23.76 | 22.57 | 23.76 | 23.13 |
| `1000_package_dependency_edges` | 5 | 41.26 | 41.47 | 41.04 | 41.47 | 41.27 |
| `tsconfig_extends_chain` | 5 | 9.45 | 9.78 | 9.32 | 9.78 | 9.54 |
| `tsconfig_reference_fanout` | 5 | 11.48 | 11.71 | 11.35 | 11.71 | 11.51 |
| `cargo_workspace_discovery` | 5 | 11.63 | 11.66 | 11.56 | 11.66 | 11.62 |
| `cargo_path_dependency_fanout` | 5 | 12.44 | 12.53 | 12.37 | 12.53 | 12.44 |
| `fresh_build_config_aware_impact` | 5 | 60.68 | 78.05 | 29.65 | 78.05 | 57.2 |
| `stale_scoped_config_widening` | 5 | 34.33 | 34.91 | 34.11 | 34.91 | 34.44 |
| `malformed_package_local_config` | 5 | 34.96 | 35.61 | 34.85 | 35.61 | 35.08 |
| `workspace_root_uncertainty` | 5 | 36.75 | 40.78 | 33.92 | 40.78 | 37.17 |
| `why_explanation_through_build_path` | 5 | 24.48 | 24.58 | 24.37 | 24.58 | 24.46 |
