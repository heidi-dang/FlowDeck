# Milestone 4: Verifiable Transitive Impact & Change Intelligence Benchmark Report

- **Source Functional SHA**: `c0077186f208e3541cfd54c2d59b8d124c23e842`
- **Branch**: `feat/fdx-verifiable-change-intelligence`
- **Timestamp**: `2026-08-22T13:00:03.527Z`
- **Platform**: `linux-x64`

---

## Benchmark Results

| Scenario | Median (ms) | p95 (ms) | Min (ms) | Max (ms) | Impact Count | Assurance |
|---|---|---|---|---|---|---|
| **Change Extraction** | 2.03 | 2.64 | 1.94 | 2.64 | - | - |
| **Fresh SCIP Impact** | 20.63 | 28.63 | 20.4 | 28.63 | 2 | DEGRADED |
| **Effective Stale Fallback** | 24.18 | 24.71 | 23.99 | 24.71 | 3 | DEGRADED |
| **Deleted-Symbol Impact** | 16.7 | 37.05 | 10.56 | 37.05 | 2 | DEGRADED |
| **1-Hop Impact** | 8.17 | 8.92 | 7.57 | 8.92 | 2 | DEGRADED |
| **3-Hop Impact** | 9.37 | 19.47 | 8.18 | 19.47 | 4 | DEGRADED |
| **Why Explanation** | 28.9 | 30.32 | 23.98 | 30.32 | 1 | - |
| **Cycle Graph** | 15.87 | 16.33 | 13.55 | 16.33 | 2 | DEGRADED |
| **Synthetic (100 edges)** | 22.52 | 23.06 | 22.08 | 23.06 | 101 | DEGRADED |
| **Synthetic (1,000 edges)** | 63.18 | 66.72 | 63.08 | 66.72 | 1001 | DEGRADED |

---

## Reproduction Command

```bash
cargo build -p fdx --release
node scripts/benchmark-fdx-vci-m4.mjs
```
