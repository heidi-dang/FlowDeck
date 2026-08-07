# P1-B Final Repair Gate — Local Closure Evidence

**Branch:** `feat/orchestration-master-plan-completion` (PR #113, draft)
**Local head at closure:** `eda7796` (implementation commits dc15845, 61c3067,
c07dfbf, be06726, eda7796 atop P1-A 86d0789..05b99db)
**Status:** implementation complete; exact-head CI results recorded as a PR
comment after workflows complete.

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
| `npm test` | 4608 pass, 2 fail (evidence-descent gate, mid-stream mixed HEAD) |
| `cargo fmt` / `clippy -D warnings` / `cargo test` | pass |
| `npm audit` | 0 vulnerabilities |
| `npm run verify:production` | 5/6 suites pass; Phase 8 fails on both heads (pre-existing benchmark-artifacts interaction, reproduced on 2f388ed) |
| `node scripts/pre-push.mjs --full` | only evidence-descent gate fails on mixed HEAD (resolved by artifacts-only final commit) |

## Remaining open Master Plan findings

See `remaining-findings-matrix.json` — fdx-secure-exec trusted package
boundary, macOS/Windows secure execution, routing Tasks 5–12, Windows daemon
IPC, PR #112 cache transaction semantics, verify:production authority, and
Phase 0–12 traceability remain OPEN. This repair gate does not claim full
Master Plan completion.
