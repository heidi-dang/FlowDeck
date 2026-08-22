# Milestone 4: Verifiable Transitive Impact & Change Intelligence Benchmark Report

- **Source Functional SHA**: `4512e1cc3a90eb4e82dc9d821a5c4b264dd9325c`
- **Branch**: `feat/fdx-verifiable-change-intelligence`
- **Timestamp**: `2026-08-22T13:45:17.726Z`
- **Platform**: `linux-x64`

---

## Benchmark Results

| Scenario | Median (ms) | p95 (ms) | Min (ms) | Max (ms) | Impact Count | Assurance |
|---|---|---|---|---|---|---|
| **Change Extraction** | 2.02 | 2.76 | 1.93 | 2.76 | - | - |
| **Fresh SCIP Impact** | 27.07 | 28.26 | 8.71 | 28.26 | 4 | DEGRADED |
| **Effective Stale Fallback** | 31.97 | 33.37 | 31.66 | 33.37 | 5 | DEGRADED |
| **Deleted-Symbol Impact** | 40.82 | 42.15 | 40.39 | 42.15 | 2 | DEGRADED |
| **1-Hop Impact** | 10.21 | 12.42 | 7.65 | 12.42 | 2 | DEGRADED |
| **3-Hop Impact** | 28.35 | 29.5 | 12.99 | 29.5 | 4 | DEGRADED |
| **Why Explanation** | 28.15 | 29.06 | 25.89 | 29.06 | 1 | - |
| **Cycle Graph** | 26.01 | 26.71 | 25.75 | 26.71 | 2 | DEGRADED |
| **Synthetic (100 edges)** | 12.78 | 13.7 | 12.43 | 13.7 | 101 | DEGRADED |
| **Synthetic (1,000 edges)** | 63.47 | 64.14 | 62.59 | 64.14 | 1001 | DEGRADED |

---

## Reproduction Command

```bash
cargo build -p fdx --release
node scripts/benchmark-fdx-vci-m4.mjs
```
