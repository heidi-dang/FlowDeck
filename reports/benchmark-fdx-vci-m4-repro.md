# Milestone 4: Verifiable Transitive Impact & Change Intelligence Benchmark Report

- **Functional Source SHA**: `601d47ba48e0d3cdcbb367346716706648e9770d`
- **Benchmark Harness SHA**: `4ba031fe4cd70829fb8433754f9ca1b56b2fc3f3`
- **Binary Source SHA**: `601d47ba48e0d3cdcbb367346716706648e9770d`
- **Branch**: `feat/fdx-verifiable-change-intelligence`
- **Timestamp**: `2026-08-22T14:58:31.415Z`
- **Platform**: `linux-x64`

---

## Benchmark Results

| Scenario | Median (ms) | p95 (ms) | Min (ms) | Max (ms) | Impact Count | Assurance |
|---|---|---|---|---|---|---|
| **Change Extraction** | 2.06 | 2.78 | 2.02 | 2.78 | - | - |
| **Fresh SCIP Impact** | 19.11 | 19.78 | 9.27 | 19.78 | 5 | DEGRADED |
| **Effective Stale Fallback** | 32.85 | 33.37 | 32.64 | 33.37 | 6 | DEGRADED |
| **Deleted-Symbol Impact** | 41.55 | 44.17 | 41.26 | 44.17 | 2 | DEGRADED |
| **1-Hop Impact** | 8.5 | 18.84 | 7.88 | 18.84 | 2 | DEGRADED |
| **3-Hop Impact** | 29.36 | 30.82 | 24.69 | 30.82 | 4 | DEGRADED |
| **Why Explanation** | 29.1 | 32.61 | 26.72 | 32.61 | 1 | - |
| **Cycle Graph** | 26.92 | 27.9 | 26.54 | 27.9 | 2 | DEGRADED |
| **Synthetic (100 edges)** | 21.66 | 22.58 | 21.5 | 22.58 | 101 | DEGRADED |
| **Synthetic (1,000 edges)** | 59.28 | 60.14 | 58.45 | 60.14 | 1001 | DEGRADED |

---

## Reproduction Command

```bash
FDX_BINARY_PATH=/path/to/functional/release/fdx node scripts/benchmark-fdx-vci-m4.mjs
```
