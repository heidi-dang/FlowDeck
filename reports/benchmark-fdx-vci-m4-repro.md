# Milestone 4: Verifiable Transitive Impact & Change Intelligence Benchmark Report

- **Source Functional SHA**: `6fa63aa38b677aee4c7d1b5e87d77f8ef177a435`
- **Branch**: `feat/fdx-verifiable-change-intelligence`
- **Timestamp**: `2026-08-22T11:36:30.107Z`
- **Platform**: `linux-x64`

---

## Benchmark Results

| Scenario | Median (ms) | p95 (ms) | Min (ms) | Max (ms) | Impact Count | Assurance |
|---|---|---|---|---|---|---|
| **Change Extraction** | 2.01 | 2.7 | 1.94 | 2.7 | - | - |
| **Fresh SCIP Impact** | 15.61 | 16.24 | 11.88 | 16.24 | 2 | DEGRADED |
| **Effective Stale Fallback** | 22.38 | 22.59 | 18.65 | 22.59 | 3 | DEGRADED |
| **Deleted-Symbol Impact** | 24.89 | 25.46 | 19.74 | 25.46 | 2 | DEGRADED |
| **1-Hop Impact** | 8.14 | 10.09 | 7.57 | 10.09 | 2 | DEGRADED |
| **3-Hop Impact** | 12.1 | 12.42 | 11.15 | 12.42 | 4 | DEGRADED |
| **Why Explanation** | 12.1 | 12.53 | 11.97 | 12.53 | 1 | - |
| **Cycle Graph** | 23.92 | 24.36 | 23.79 | 24.36 | 2 | DEGRADED |
| **Synthetic (100 edges)** | 14.19 | 14.95 | 13 | 14.95 | 101 | DEGRADED |
| **Synthetic (1,000 edges)** | 62.76 | 65.12 | 61.46 | 65.12 | 1001 | DEGRADED |

---

## Reproduction Command

```bash
cargo build -p fdx --release
node scripts/benchmark-fdx-vci-m4.mjs
```
