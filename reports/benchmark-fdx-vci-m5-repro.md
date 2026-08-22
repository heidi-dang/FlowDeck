# Milestone 5 Build/Config Graph Federation Benchmark Report

## Provenance

- **Benchmark Name**: `benchmark-fdx-vci-m5-build-config`
- **Timestamp**: `2026-08-22T17:11:48.081Z`
- **Functional Source SHA**: `0f5e3ed9d94509d3539ffbf84a7507ec1fdb60bd`
- **Binary Source SHA**: `0f5e3ed9d94509d3539ffbf84a7507ec1fdb60bd`
- **Benchmark Harness SHA**: `243bc7f983cdec5db8138deafcdca4135206e186`
- **Platform**: `linux (x64)`

## Performance Results

| Benchmark Scenario | Samples | Median (ms) | P95 (ms) | Min (ms) | Max (ms) | Mean (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `package_json_workspace_discovery` | 5 | 9.76 | 9.78 | 9.67 | 9.78 | 9.74 |
| `100_package_workspace_graph` | 5 | 27.4 | 27.82 | 27.09 | 27.82 | 27.43 |
| `1000_package_dependency_edges` | 5 | 43.77 | 44.43 | 43.21 | 44.43 | 43.84 |
| `tsconfig_extends_chain` | 5 | 9.77 | 10.01 | 9.56 | 10.01 | 9.77 |
| `tsconfig_reference_fanout` | 5 | 11.28 | 11.61 | 11.17 | 11.61 | 11.37 |
| `cargo_workspace_discovery` | 5 | 13.68 | 14.31 | 13.48 | 14.31 | 13.76 |
| `cargo_path_dependency_fanout` | 5 | 14.68 | 14.74 | 14.52 | 14.74 | 14.65 |
| `fresh_build_config_aware_impact` | 5 | 144.21 | 144.72 | 99.52 | 144.72 | 135.31 |
| `stale_scoped_config_widening` | 5 | 51.32 | 51.41 | 50.93 | 51.41 | 51.25 |
| `malformed_package_local_config` | 5 | 28.36 | 56.71 | 26.63 | 56.71 | 36.54 |
| `workspace_root_uncertainty` | 5 | 50.46 | 51.39 | 50.35 | 51.39 | 50.68 |
| `why_explanation_through_build_path` | 5 | 62.01 | 62.72 | 61.76 | 62.72 | 62.09 |
