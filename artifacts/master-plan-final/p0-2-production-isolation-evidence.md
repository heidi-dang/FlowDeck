# P0-2: Better Harness Production Isolation — Evidence Log

**Objective:** Remove the active Better Harness split-brain production runtime from
the FlowDeck production plugin and integrate the fix through a standalone CLI plus
an explicit canonical-evidence importer. The production plugin must have exactly
one writable orchestration authority.

**Branch:** `feat/orchestration-master-plan-completion` (PR #113, draft)
**Starting SHA:** `ccb43a4934a06ad9c8d8114fe7525f2dea05520f`
**Result:** Readiness 9.6/10

## Implementation Commits

| SHA | Type | Change |
|-----|------|--------|
| `d5c843e` | fix(config) | Fail closed on `betterHarness.enabled=true`; validator + default removal |
| `c74e0dd` | fix(runtime) | Remove Better Harness imports/startup from `src/index.ts`; scope stores/coordinator/router to instance `stateDir` |
| `a324069` | feat(harness) | Standalone `flowdeck-better-harness` CLI + `bin/better-harness.js` |
| `0fd5872` | feat(evidence) | `CanonicalEvidenceImportAdapter` bound to exact run + SHA |
| `f500bc9` | test(harness) | 17 isolation tests + reachability/persistence inventories |
| (this commit) | chore(evidence) | Evidence-only descent record (artifacts/ only) |

## Local Gate Evidence

- `bun run lint` — pass
- `bun run typecheck` — pass (0 errors)
- `bun run build` — pass
- `bun test tests/better-harness/` — 396/396 pass
- `bun test tests/harness-production-isolation.test.ts` — 17/17 pass
- Mandatory production suites (`tests/consistency/`, `tests/trace-replay/`,
  `tests/fault-injection/`, `tests/orchestration/`, `tests/runtime-persistence/`,
  `tests/phase8-ci-production-gates/`) — 931/932 pass; the single failure
  (`Production Composition Deep Integration > completion update throws immutable
  error`) fails identically on the starting SHA when run in the same process as
  the fault-injection suite — pre-existing cross-suite interference, not caused
  by this change.
- `node scripts/pre-push.mjs` — "All fast pre-push checks passed"
- Fail-closed smoke test — `betterHarness.enabled=true` rejected at load with
  migration message; default config has no `betterHarness` key.
- Full local suite: 4553 pass / 94 fail / 11 errors. All failures are
  pre-existing environment-only classes, identical on the starting SHA:
  stale local FDX native binary/daemon (CI builds via `cargo build`), missing
  Playwright browsers (CI installs them), and parallel-run fault-injection
  interference (`tests/phase28-state-memory-gates` passes in isolation).

## CI Production Gates

First run (31105525645): failure — Test Matrix (all OSes) and Coverage Check
failed on `validateEvidenceOnlyDescent` only (2 assertions). Root cause: the
final commit mixed `tests/` and `artifacts/`; the gate requires the diff
`HEAD~1..HEAD` to contain only `artifacts/**`. Fixed by the evidence-only
commit `74b3267` (artifacts/ only), matching the branch convention (see
`ccb43a4`).

Final run on `74b3267`:

| Workflow | Run ID | Conclusion |
|----------|--------|-----------|
| CI Production Gates | 31109226414 | success (13m0s) |
| Orchestration Validation | 31109225057 | success |
| Build FDX Native Packages | 31109221978 | success |

CI Production Gates jobs: Test Matrix (ubuntu/macos/windows), Coverage Check,
Lint & Typecheck, Typecheck, Build & Validate, Rust Gates (FDX), Security Scan,
Runtime Benchmark (Branch-Head), FDX Native Parity, FDX Index Benchmark
(exact-SHA), Installer Tests, Local Installer (all OSes), Packed CLI (all OSes)
— all green.

## Proof of Single Orchestration Authority

- `src/index.ts` contains no HarnessRuntime/HarnessHttpServer/SseManager/
  ProjectRegistry/RouterContext imports or startup; verified by
  `tests/harness-production-isolation.test.ts`.
- Harness persistence stores never touch canonical tables (`task_runs`,
  `assignments`, `completion_decisions`, `events`, `event_outbox`); canonical
  evidence is written only via `CanonicalEvidenceImportAdapter` which rejects
  missing/mismatched SHAs.
- `setFlowDeckStateDir` global override is deprecated and never invoked by the
  runtime; instance-scoped `stateDir` threads through coordinator/router.

## Final Repair Gate Closure (P1-B)

Closes the PR #113 final repair gate on top of the P0-2 commits: the
Better Harness runtime ships as a packed standalone CLI (no TypeScript source
fallback in installed packages) and harness evidence enters the canonical
store only through a transactional, idempotent canonical importer bound to a
real canonical run + SHA.

### New artifacts (P1-B)

- `src/better-harness/evidence/canonical-evidence-adapter.ts` — rewritten as a
  canonical transactional import service: authoritative run lookup via
  `CanonicalRunReader`, exact-SHA validation, eligibility + superseded-report
  rejection, criterion contract/run validation, deterministic idempotency
  (`INSERT OR IGNORE` scoped reservations inside the transaction),
  provenance persisted as canonical JSON on the evidence description, one
  `SqliteUnitOfWork` transaction for evidence + lifecycle + linkage +
  idempotency + batch event/outbox, full rollback on any throw.
- `src/better-harness/evidence/import-identity.ts` — deterministic report
  fingerprints, content hashes, per-item idempotency keys, evidence ids.
- `src/better-harness/evidence/import-errors.ts` — typed errors + reason codes
  for every rejection path.
- `src/orchestration/evidence/ports/canonical-run-reader.ts` +
  `src/orchestration/evidence/adapters/sqlite-canonical-run-reader.ts` —
  authoritative canonical run lookup over `task_runs`.
- `src/orchestration/evidence/adapters/sqlite-evidence-repository.ts` —
  `EvidenceRepository` over the frozen v0.2.6 schema.
- `src/orchestration/idempotency/adapters/sqlite-idempotency-repository.ts` —
  `IdempotencyRepository` over `command_idempotency`.
- `tests/canonical-harness-evidence-import.test.ts` — 27 mandatory cases
  (run binding, SHA validation, eligibility, superseded, criterion binding,
  idempotency, interrupted retry, fault-injection rollback, provenance
  completeness/immutability, deterministic identity, harness-run containment,
  completion-gate non-bypass, FK/integrity) against the real frozen
  v0.2.6 schema.
- `tests/harness-production-isolation.test.ts` — section 4 rewritten to bind
  against a REAL canonical run fixture (rejects unknown/arbitrary runs,
  imports only against the real run) — 19/19 pass.
- `docs/architecture/integration/runtime-authority.md` — P1-B section:
  packed CLI build output, installed tarball lifecycle, three-OS CI gate,
  canonical run lookup, exact-SHA validation, eligibility rules, idempotency
  design, provenance schema, transaction boundary, rollback behavior.

### Final gate verification (local)

- `bun tsc --noEmit` — 0 errors.
- `bun test tests/canonical-harness-evidence-import.test.ts` — 27/27 pass.
- `bun test tests/harness-production-isolation.test.ts` — 19/19 pass.
- `bun test tests/better-harness/packed-standalone-cli.test.ts` — 6/6 pass.
- `bun test tests/better-harness` — 402/402 pass.
- `npm run validate:architecture-freeze` — PASS (canonical v0.2.6 artifacts
  verified; frozen schema untouched).
- `git diff --check` — clean.

### Proof of single orchestration authority (extended)

- The packed CLI is the ONLY supported harness runtime entry; the installed
  package resolves `dist/better-harness/standalone.js` + `bin/better-harness.js`
  and never falls back to TypeScript source.
- The canonical importer loads the authoritative run through
  `CanonicalRunReader` — arbitrary `task_run_*` / `run_*` strings are rejected
  with `CANONICAL_RUN_NOT_FOUND`; evidence binds to the real canonical run +
  current SHA only.
- The importer never writes `task_runs`, `assignments`, or
  `completion_decisions`; imported evidence cannot create completion
  decisions or bypass completion gates (`evaluateAllGates` still fails with
  only imported evidence and no passing verification).
- Harness run ids never become canonical run ids (provenance keeps
  `harnessRunId` separate from `canonicalRunId`).
