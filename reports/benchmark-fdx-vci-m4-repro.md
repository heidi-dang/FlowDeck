# Milestone 4: Verifiable Transitive Impact & Change Intelligence Benchmark Report

- **Functional Source SHA**: `601d47ba48e0d3cdcbb367346716706648e9770d`
- **Benchmark Harness SHA**: `fbcce3aed23abab2ac7ef877c52ca6e542957551`
- **Binary Source SHA**: `601d47ba48e0d3cdcbb367346716706648e9770d`
- **Branch**: `feat/fdx-verifiable-change-intelligence`
- **Timestamp**: `2026-08-22T15:25:24.622Z`
- **Platform**: `linux-x64`

---

## Benchmark Results

| Scenario | Median (ms) | p95 (ms) | Min (ms) | Max (ms) | Impact Count | Assurance |
|---|---|---|---|---|---|---|
| **Change Extraction** | 2.03 | 2.22 | 1.91 | 2.22 | - | - |
| **Fresh SCIP Impact** | 27.9 | 28.48 | 10.03 | 28.48 | 5 | DEGRADED |
| **Effective Stale Fallback** | 32.72 | 34.07 | 32.31 | 34.07 | 6 | DEGRADED |
| **Deleted-Symbol Impact** | 41.15 | 41.65 | 12.43 | 41.65 | 2 | DEGRADED |
| **1-Hop Impact** | 9.86 | 12.73 | 7.68 | 12.73 | 2 | DEGRADED |
| **3-Hop Impact** | 26.82 | 27.7 | 13.88 | 27.7 | 4 | DEGRADED |
| **Why Explanation** | 26.85 | 27.13 | 26.65 | 27.13 | 1 | - |
| **Cycle Graph** | 26.61 | 26.86 | 18.05 | 26.86 | 2 | DEGRADED |
| **Synthetic (100 edges)** | 21.62 | 22.41 | 21.42 | 22.41 | 101 | DEGRADED |
| **Synthetic (1,000 edges)** | 63.29 | 65.14 | 62.92 | 65.14 | 1001 | DEGRADED |

---

## Reproduction Command

```bash
FDX_BINARY_PATH=/path/to/functional/release/fdx node scripts/benchmark-fdx-vci-m4.mjs
```
