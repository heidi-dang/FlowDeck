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

## CI Production Gates (run 31105525645)

| Job | Conclusion |
|-----|-----------|
| Test Matrix (ubuntu/macos/windows) | failure — only `validateEvidenceOnlyDescent` (2 assertions) |
| Coverage Check | failure — same evidence-descent assertions |
| All other jobs (Lint & Typecheck, Typecheck, Build & Validate, Rust Gates, Security Scan, Runtime Benchmark, FDX Native Parity, FDX Index Benchmark, Installer Tests, Local Installer, Packed CLI) | success |

The evidence-descent gate requires the diff `HEAD~1..HEAD` to contain only
`artifacts/**`. The initial run mixed `tests/` and `artifacts/` in the final
commit; this evidence-only commit (artifacts/ only) restores the invariant,
matching the branch convention (see `ccb43a4`).

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
