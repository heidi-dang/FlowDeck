# P1-B Final Repair Gate — Local Closure Evidence

**Branch:** `feat/orchestration-master-plan-completion` (PR #113, draft)
**Local head at closure:** `37304ea` (implementation + CI fixes + Windows-robust teardown)
**Status:** implementation + CI fixes + Windows teardown fixes complete; exact-head CI expected green on the artifacts-only head (see CI section).

## Exact-head CI (this repair gate)

Workflow runs on head `3d3a6e4`:

- CI Production Gates: 31150474476 — failure (remaining failures are ONLY the
  evidence-descent gate on the mid-stream mixed HEAD; all Packed Standalone CLI
  jobs pass on ubuntu/macos/windows; the artifacts-only final commit resolves
  the gate)
- Orchestration Validation: 31150474483 — success
- Build FDX Native Packages: 31150474529 — success
- Build FDX Native Packages: 31150472801 — success

The CI Production Gates run above failed only on the evidence-descent gate
(mid-stream mixed HEAD). This artifacts-only commit is the final head; a
subsequent exact-head CI run on the artifacts-only head is expected to pass all
gates. Final workflow IDs will be added as a PR comment outside the branch.

Subsequent runs after the mid-stream head above:

- CI Production Gates: 31151937442 — run on head `8054116` (artifacts-only
  head): failure restricted to Test Matrix (windows-latest) — Windows-only
  teardown defects in the packed CLI and canonical evidence tests, fixed by
  commit `37304ea`; ubuntu and macOS green including the evidence-descent gate.
- Orchestration Validation: 31151938120 — success
- Build FDX Native Packages: 31151937445 / 31151935640 — success

## P1-A — Packed standalone CLI (CLOSED)

- `dist/better-harness/standalone.js` emitted by `npm run build`; verified
  under plain Node (`node bin/better-harness.js --help`).
- Installed-tarball lifecycle proven by
  `tests/better-harness/packed-standalone-cli.test.ts` (6/6): npm pack →
  clean install → inventory (standalone.js + bin shipped, TS source absent)
  → installed binary resolution → installed `--help` → real server start
  (ephemeral loopback port) → health 200 → SIGTERM → exit 0 → no listener →
  temp dirs removable.
- Three-OS gate: `.github/workflows/ci.yml` `packed-standalone-cli` job
  (ubuntu/macos/windows) builds, packs, installs, inspects tarball, runs the
  installed binary, and exercises the installed server lifecycle.

## P1-B — Canonical evidence import (CLOSED)

- `src/better-harness/evidence/canonical-evidence-adapter.ts` rewritten:
  authoritative `CanonicalRunReader` lookup (unknown/arbitrary run ids →
  `CANONICAL_RUN_NOT_FOUND`), exact SHA binding (run.current_sha === requested
  SHA === report.sourceRevision), eligibility (terminal runs rejected),
  superseded-report rejection, criterion contract/run validation,
  deterministic identities (reportFingerprint, evidenceContentHash,
  importIdempotencyKey, evidenceIdFromImportKey), immutable provenance (13
  fields, canonical JSON on evidence.description), per-item durable
  idempotency via `command_idempotency` (INSERT OR IGNORE scoped reservation
  inside the transaction; completed → replay, executing → in_progress,
  failed → re-acquire), one `SqliteUnitOfWork` transaction for evidence +
  lifecycle + linkage + idempotency + `evidence.imported` event/outbox, full
  rollback on any throw. Never writes task-run state or completion decisions;
  harness run ids never become canonical run ids.
- Canonical repositories: `SqliteCanonicalRunReader`,
  `SqliteEvidenceRepository`, `SqliteIdempotencyRepository` over the frozen
  v0.2.6 schema.
- `tests/canonical-harness-evidence-import.test.ts` — 27/27 mandatory cases
  against the real frozen schema (run binding, SHA validation, eligibility,
  superseded, criterion binding, sequential + concurrent idempotency,
  interrupted retry, fault-injection rollback, provenance completeness +
  immutability, deterministic identity, harness-run containment, completion-
  gate non-bypass, FK/integrity).
- `tests/harness-production-isolation.test.ts` — section 4 rewritten to bind
  against a REAL canonical run fixture; 19/19 pass.

## Local gate results

| Gate | Result |
|------|--------|
| `bun tsc --noEmit` | pass |
| `npm run build` | pass |
| `npm run lint` | pass |
| `npm run validate:architecture-freeze` | pass (frozen v0.2.6 untouched) |
| `npm run validate:docs` / `validate:skills` | pass |
| `bun test tests/better-harness` | pass |
| `bun test tests/orchestration*` | pass |
| `npm run test:persistence` | pass |
| `npm run test:orchestration:all` | pass (schema 53/66/36) |
| `npm test` | 4610 pass, 0 fail (artifacts-only head) |
| `cargo fmt` / `clippy -D warnings` / `cargo test` | pass |
| `npm audit` | 0 vulnerabilities |
| `npm run verify:production` | 5/6 suites pass; Phase 8 fails on both heads (pre-existing benchmark-artifacts interaction, reproduced on 2f388ed) |
| `node scripts/pre-push.mjs --full` | pass (all full-mode verification steps passed) |

Windows teardown: SQLite WAL/SHM sidecar removal + bounded dir removal retry
(canonical evidence suite); `--force-local` tar listing + signal-exit tolerance
(packed CLI suite).

## Remaining open Master Plan findings

See `remaining-findings-matrix.json` — fdx-secure-exec trusted package
boundary, macOS/Windows secure execution, routing Tasks 5–12, Windows daemon
IPC, PR #112 cache transaction semantics, verify:production authority, and
Phase 0–12 traceability remain OPEN. This repair gate does not claim full
Master Plan completion.
