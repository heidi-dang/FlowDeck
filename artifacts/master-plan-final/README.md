# Master Plan Final — Evidence Artifacts

Evidence for the orchestration master plan phases 0–12 completion on
`feat/orchestration-master-plan-completion`.

## TDD RED evidence (tests failing before fixes)

| File | Captured from | What it proves |
|------|---------------|----------------|
| `rust-red.log` | `cargo test --lib` (256 tests) | Batch-cache/index suite RED: 237 passed, 19 failed before deferred-visibility + atomic-publish + reuse-revalidation fixes |
| `rust-batch-red.log` | `cargo test --lib batch` | Batch subset RED: 56 passed, 11 failed |
| `rust-batch-red-final.log` | `cargo test --lib batch` | Final iteration RED: 66 passed, 1 failed (durability-warning contract) |
| `typescript-persistence-red.log` | `bun .scratch/p12-debug.mjs` | Persistence gate RED: `SQLiteError: no such table: main.objectives` at section-7 `applySchema` (full exec) |
| `typescript-persistence-stmt-red.log` | `bun .scratch/p12-instr4.mjs` | Same failure traced per-statement: `disk I/O error` (`SQLITE_IOERR_WRITE`) at stmt 3 `CREATE UNIQUE INDEX uq_contract_family_active` |
| `typescript-suite-red.log` | `bun test` (full suite) | TS suite RED: fdx-artifact verification/install failures (stale `9.9.9` version, missing native binary, provenance mismatch) |
| `production-gates-red.log` | `bun test` (production gates) | Production-readiness RED: fdx-native-distribution, fdx-trusted-acquisition, phase-8 CI gates, installer failures |

## Root-cause notes (persistence gate)

The section-7 `applySchema(dbSchema)` failure was environmental, not a code
bug: `/tmp` is a 1.7G tmpfs that sat at ~80% capacity (1.4G used), and SQLite
WAL mode fails with `SQLITE_IOERR_WRITE`/partial-apply under that pressure.
Verified by bisection (any 3 of sections 1–4 pass; all 4 fail), FD-count
probe (27/524288, not a leak), WAL-vs-DELETE toggle (WAL fails, DELETE
passes), and disk-vs-tmpfs path swap (disk passes, tmpfs fails). Freed ~190M
of stale downloads; the gate passes. `clean()` in `phase1-2-tests.mjs` was
also extended to remove `-schema`/`-schema-wal`/`-schema-shm`/`-schema-lock`
files so repeated runs are idempotent.

## GREEN counterpart

- `cargo test` — 257 passed, 0 failed
- `npm run test:persistence` — all files 0 failed
- `bun test` full suite — 4498 passed, 2 skipped, 0 failed
- `node scripts/pre-push.mjs` — pass

## Runtime authority phase (single writable state store)

- `runtime-authority-green.log.md` — fail-fast evidence: 198 pass / 0 fail on
  the runtime + state-machine suites; full orchestration 757 pass; typecheck
  clean.
- `docs/architecture/integration/runtime-authority.md` — ADR: state store is
  the single writable authority; no silent in-memory fallback in production;
  atomic `createRun`; no shadow maps. better-harness and stream repositories
  are separate subsystems, out of scope.
