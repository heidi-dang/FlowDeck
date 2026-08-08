# Ownership Map — FDX and Tool Performance (Dev 3)

**Developer:** Dev 3
**Program:** FDX and Tool Performance
**Frozen FlowDeck harness:** v1.0.3
**Date:** 2026-08-01

## Dev 3 Owns (exclusive)

| Path | Reason |
|---|---|
| `crates/fdx/**` | FDX native CLI + future daemon. Sole owner. |
| `src/tools/fdx.ts` | FDX tool registry (14 slash tools). |
| `src/tools/fdx-shared.ts` | Client wrapper: spawn, fallbacks, validation, discovery. |
| `src/tools/fdx-validate.ts`, `fdx-worktree.ts`, `fdx-pr-monitor.ts` | Adjacent FDX tooling. |
| `scripts/verify-fdx-parity.mjs` | Cross-runtime parity gate. |
| `scripts/bench-fdx-baseline.mjs` | Baseline/perf benchmark harness. |
| `tests/fdx-*.test.ts` + phase6/phase28/phase32 FDX tests | FDX coverage. |
| `docs/architecture/FDX_PERFORMANCE_DAEMON_IMPLEMENTATION_PLAN.md` | This program's plan. |
| `docs/architecture/performance/**` | Baseline + ownership + reports. |
| npm scripts: `benchmark:fdx`, `test:fdx-daemon`, `test:fdx-protocol`, `test:fdx-cache`, `test:fdx-batch`, `test:fdx-cancellation`, `test:fdx-faults`, `test:fdx-soak`, `test:fdx-cross-platform`, `report:self-host` | Program deliverable surface. |

## Dev 2 Must Relinquish (to Dev 3)

Any FDX or tool-performance ownership Dev 2 previously held for the paths above. Dev 3's exclusive ownership starts at baseline `5809fcf`.

## Dev 3 Does NOT Touch

- `src/tools/` files outside `fdx*` (e.g. other tool implementations, unless required for client integration — then coordinate).
- Dev 1's SSE/live-UI files (`src/services/` SSE, `src/hooks/` live-UI, UI components).
- `tests/orchestration/persistence/**` (excluded from `test` script).
- `.github/workflows/publish.yml` (release gate; additive npm scripts only).
- `dist/`, `node_modules/`, `bun.lock`, `Cargo.lock` (lockfile only via `cargo` when adding deps).

## Arbitration

On ownership conflict, the orchestrator arbitrates. No silent edits of another developer's owned files. Report conflicts in the standard report header.

## Baseline Reference

- Baseline commit: `5809fcf1230ff349ff0d7f5b53ed75403f44573b`
- Branch: `feat/fdx-performance-daemon`
- Frozen harness: FlowDeck v1.0.3
