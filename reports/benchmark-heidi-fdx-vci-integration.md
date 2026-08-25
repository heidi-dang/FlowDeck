# Heidi FDX VCI Integration Benchmark

**Date:** 2026-08-25T05:49:54.998Z
**Platform:** linux-x64

## Scenario Results

| Scenario | Total ms |
|----------|----------|
| simple-task-overhead | 49 |
| capabilities-dry-run | 2 |
| mutation-classification | 1 |
| stale-evidence-detection | 1 |
| recovery-bounds | 1 |

## Architecture Verification
- FDX: code-change intelligence and verification authority ✓
- Heidi: primary orchestrator ✓
- Repo Master: uses FDX facts instead of re-scanning ✓
- Specialists: spawned dynamically only when useful ✓
- Simple tasks: no unnecessary VCI workflow ✓
- M10: measurement-only ✓
- M11: ADD_CHECK only ✓
- M1-M12 VCI history: frozen ✓
- No merge to main performed ✓