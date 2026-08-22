# Milestone 4: Verifiable Transitive Impact & Change Intelligence Benchmark Report

- **Source Functional SHA**: `5ae68af1aacf021b519b7b2eff72cc1f265f8976`
- **Branch**: `feat/fdx-verifiable-change-intelligence`
- **Timestamp**: `2026-08-22T10:54:11.685Z`
- **Platform**: `linux-x64`

---

## Benchmark Results

| Scenario | Median (ms) | p95 (ms) | Min (ms) | Max (ms) | Impact Count | Assurance |
|---|---|---|---|---|---|---|
| **Change Extraction** | 2.04 | 2.71 | 1.96 | 2.71 | - | - |
| **1-Hop Impact** | 12.91 | 13.9 | 7.91 | 13.9 | 2 | DEGRADED |
| **3-Hop Impact** | 13.05 | 26.46 | 12.94 | 26.46 | 4 | DEGRADED |
| **Why Explanation** | 26.17 | 29.75 | 7.6 | 29.75 | 1 | - |
| **Cycle Graph** | 25.83 | 26.14 | 10.43 | 26.14 | 2 | DEGRADED |
| **Synthetic (100 edges)** | 18.4 | 18.53 | 13.36 | 18.53 | 101 | DEGRADED |
| **Synthetic (1,000 edges)** | 62.03 | 62.68 | 60.94 | 62.68 | 1001 | DEGRADED |

---

## Reproduction Command

```bash
cargo build -p fdx --release
node scripts/benchmark-fdx-vci-m4.mjs
```
