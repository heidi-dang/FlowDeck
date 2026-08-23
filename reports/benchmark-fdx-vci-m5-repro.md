# Milestone 5 Build/Config Graph Federation Benchmark Report

## Provenance

- **Benchmark Name**: `benchmark-fdx-vci-m5-build-config`
- **Timestamp**: `2026-08-23T00:48:18.124Z`
- **Functional Source SHA**: `c60e666eb14c96ca9ebbbe77c4846e56edb108c6`
- **Binary Source SHA**: `c60e666eb14c96ca9ebbbe77c4846e56edb108c6`
- **Benchmark Harness SHA**: `378cfd93af97a7d4c34182544221a414cb18e043`
- **Platform**: `linux (x64)`

## Performance Results

| Benchmark Scenario | Samples | Median (ms) | P95 (ms) | Min (ms) | Max (ms) | Mean (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `package_json_workspace_discovery` | 5 | 10.22 | 10.31 | 10.04 | 10.31 | 10.17 |
| `100_package_workspace_graph` | 5 | 27.79 | 28.31 | 27.66 | 28.31 | 27.91 |
| `1000_package_dependency_edges` | 5 | 44.49 | 44.86 | 44.05 | 44.86 | 44.49 |
| `tsconfig_extends_chain` | 5 | 9.79 | 9.98 | 9.65 | 9.98 | 9.81 |
| `tsconfig_reference_fanout` | 5 | 11.38 | 11.7 | 11.06 | 11.7 | 11.38 |
| `cargo_workspace_discovery` | 5 | 13.86 | 14.31 | 13.56 | 14.31 | 13.9 |
| `cargo_path_dependency_fanout` | 5 | 14.72 | 14.89 | 14.64 | 14.89 | 14.75 |
| `fresh_build_config_aware_impact` | 5 | 151.44 | 151.54 | 132.29 | 151.54 | 145.1 |
| `stale_scoped_config_widening` | 5 | 52.73 | 53.36 | 52.66 | 53.36 | 52.86 |
| `malformed_package_local_config` | 5 | 59.48 | 61.04 | 58.75 | 61.04 | 59.78 |
| `workspace_root_uncertainty` | 5 | 52.98 | 53.39 | 38.41 | 53.39 | 49.31 |
| `why_explanation_through_build_path` | 5 | 65.05 | 68.62 | 64.66 | 68.62 | 65.67 |
