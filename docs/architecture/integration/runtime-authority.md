# Runtime Authority — Single Writable State Store

Status: Accepted
Date: 2026-08-06
Scope: `src/orchestration/runtime-integration.ts`, `src/orchestration/runtime/`

## Context

The orchestration runtime had multiple writable authorities for run state,
which created a split-brain risk: state written to one authority could drift
from another, and a process restart could silently lose state.

Concretely, before this change:

- `RuntimeOrchestrator` defaulted to `new InMemoryStateStore()` when no store
  was configured (`config.stateStore ?? new InMemoryStateStore()`). A
  production runtime constructed without an explicit store silently degraded
  to an in-memory store that loses all state on restart.
- `TransitionService` had the same implicit fallback.
- `RuntimeOrchestrator` kept three write-only in-memory `Map`s
  (`runStates`, `runContracts`, `contextBudgets`) that shadowed the store.
  They were written but never read, so they could not be trusted as an
  authority and only added drift surface.
- `createTask` used the deprecated non-atomic `saveState` + `recordEvent`
  pair instead of the atomic `createRun`, so a crash between the two calls
  could leave a run with state but no creation event (or vice versa).

## Decision

1. **The state store is the single writable authority** for run state,
   contracts, transition events, context budgets, and completion decisions.
   There is no second writable state to keep in sync.

2. **No silent in-memory fallback in production.** `RuntimeOrchestrator` and
   `TransitionService` now fail fast (throw) when constructed without a
   durable store. The store is resolved in priority order:

   | Priority | Source | Result |
   |----------|--------|--------|
   | 1 | `config.stateStore` | explicit store (caller-owned) |
   | 2 | `config.dbPath` | `openSqliteStateStore(dbPath)` (durable SQLite) |
   | 3 | `config.devMode === true` | `InMemoryStateStore` (explicit dev/test opt-in) |
   | — | none of the above | throw with remediation |

3. **Atomic run creation.** `createTask` uses `createRun`, which persists
   state + contract + creation event in a single transaction. The deprecated
   `saveState`/`recordEvent` pair is no longer used by the runtime facade.

4. **No shadow maps.** The write-only `runStates`/`runContracts`/
   `contextBudgets` maps were removed. All reads go through the state store.

## Consequences

- Production misconfiguration (no store) now fails loudly at construction
  instead of silently losing state at runtime.
- Tests and dev tooling must opt into the in-memory store explicitly via
  `devMode: true` (or supply a store), making the in-memory path a conscious
  choice rather than a default.
- The `better-harness` subsystem (`src/better-harness/`) is a separate
  dev/QA harness with its own JSON-file run stores. It is **out of scope**
  for this authority: it is not the production orchestration runtime and is
  not referenced by the canonical architecture. Its stores are independent
  and do not write to the orchestration state store.
- The streaming repository (`src/orchestration/streaming/stream-repository.ts`)
  writes project stream events to its own SQLite DB. This is a distinct
  event-log concern (project-level stream events), separate from per-run
  orchestration state, and is not part of the run-state authority.

## Better Harness Standalone CLI + Canonical Evidence Import (P1-B repair gate)

The Better Harness dev/QA runtime is delivered exclusively as a packed
standalone CLI, and its findings enter the canonical store only through the
transactional canonical evidence importer. This closes the split-brain repair
gate: the production plugin has one writable orchestration authority, and the
harness can never write canonical tables directly.

### Packed standalone CLI build output

- The standalone server is compiled to `dist/better-harness/standalone.js`
  (`bun build src/better-harness/standalone.ts --outdir dist/better-harness
  --target node --format esm`).
- `bin/better-harness.js` loads **only** the compiled module. The TypeScript
  source under `src/better-harness/` is intentionally NOT a runtime fallback:
  it is not shipped in the npm package, and an install missing the compiled
  module fails with a clear diagnostic (run `npm run build` or reinstall).
- The standalone server writes all state to an explicit per-instance state
  directory (`--state-dir`) and never touches canonical SQLite tables
  (`task_runs`, `assignments`, `completion_decisions`, `events`,
  `event_outbox`).

### Installed tarball lifecycle

- `npm pack` must ship `package/dist/better-harness/standalone.js` and
  `package/bin/better-harness.js`, and must NOT ship the TypeScript source as
  a runtime dependency.
- Installing the tarball (`npm install --prefix <dir> --ignore-scripts
  <tarball>`) must produce a resolvable `node_modules/.bin/flowdeck-better-harness`
  binary, a working `--help` under plain Node, and a full server lifecycle
  (start → health → stop → exit → no listener left behind).

### Three-OS CI gate

- `.github/workflows/ci.yml` runs the `packed-standalone-cli` job on a
  `[ubuntu-latest, macos-latest, windows-latest]` matrix (plus the main Test
  Matrix). It builds, packs, inspects the tarball inventory, installs into a
  clean prefix, and exercises the installed CLI — on all three OSes.

### Canonical run lookup

- Evidence imports load the authoritative canonical run through
  `CanonicalRunReader` (`SqliteCanonicalRunReader` over `task_runs`). A
  caller-provided run id is never sufficient proof of existence.
- Unknown runs and arbitrary run-like strings (`task_run_*`, `run_*`) return
  `undefined` from the reader and are rejected with `CANONICAL_RUN_NOT_FOUND`.

### Exact-SHA validation

- The canonical run must have a non-empty `current_sha`
  (`RUN_CURRENT_SHA_MISSING`).
- The requested import SHA must equal the canonical run's current SHA
  (`RUN_SHA_MISMATCH`) and must equal the report's `sourceRevision`
  (`REPORT_SHA_MISMATCH` / `REPORT_SOURCE_REVISION_MISSING`).

### Eligibility rules

- Evidence may only attach to active runs in states `created`, `planning`,
  `analysing`, `delegating`, `executing`, `verifying`, `recovering`.
  Terminal runs (`completed`, `failed`, `cancelled`) are rejected with
  `RUN_NOT_ELIGIBLE`.
- A report is `REPORT_SUPERSEDED` when a newer report (later `generatedAt`)
  with a different fingerprint has already been imported for the same
  run + SHA.
- Every requested criterion must exist in `acceptance_criteria` for the
  run's contract (`CRITERION_CONTRACT_MISMATCH`) and must have a
  `run_acceptance_criteria` row bound to the run (`CRITERION_RUN_MISMATCH`).

### Idempotency design

- Each source evidence item derives one deterministic idempotency key
  (`importIdempotencyKey`) and one deterministic canonical evidence id
  (`evidenceIdFromImportKey`), so retries map to the same row.
- The idempotency reservation is the transaction boundary: `INSERT OR IGNORE`
  into `command_idempotency` with the scoped key
  `` `${better_harness_evidence_import}:${runId}:${importKey}` `` runs INSIDE
  the transaction with the payload fingerprint stored as `fpx:<sha>` in
  `owner`. Re-read after insert: `completed` → replay the previous result
  (same evidence ids), `executing` → in-progress error, `failed` → re-acquire,
  fresh insert → proceed.
- Duplicate imports return `replayed: true` with the stored result ids and
  never create duplicate evidence rows.

### Provenance schema

- Every imported evidence row persists immutable provenance as canonical
  JSON (sorted keys) in the `description` column: `canonicalRunId`,
  `targetSha`, `harnessRunId`, `reportFingerprint`, `reportGeneratedAt`,
  `harnessFindingId`, `harnessEvidenceId`, `sourceEvidenceFingerprint`,
  `sourceCategory`, `sourceCollectedAt`, `contentHash`,
  `importIdempotencyKey`, `importedAt`, `provenanceVersion: 1`.
- The frozen schema triggers `tr_evidence_immutable_update` /
  `tr_evidence_immutable_delete` make the row permanently immutable.

### Transaction boundary and rollback

- One `SqliteUnitOfWork` wraps every write: `evidence` row +
  `evidence_lifecycle` + `run_criterion_evidence` linkage +
  `command_idempotency` reservation/completion + one `evidence.imported`
  batch event in `events` + `event_outbox`.
- The unit-of-work callback is strictly synchronous (thenables are rejected
  inside the transaction), so persistence uses direct synchronous `db.query`
  inside `tx.write`; `SqliteEvidenceRepository` remains the read/test
  surface.
- Any throw rolls back the entire transaction (evidence, lifecycle,
  linkage, idempotency, event, outbox). Unexpected persistence failures
  surface as `IMPORT_FAILED`; the importer never writes task-run state or
  completion decisions, and harness run ids never become canonical run ids.

## Verification

- `bun test tests/orchestration/` — 757 pass (includes new fail-fast
  regression tests).
- `bun tsc --noEmit -p tsconfig.prepush.json` — clean.
- Full suite: 4642 pass, 2 pre-existing unrelated failures
  (`validateEvidenceOnlyDescent` in `tests/benchmarks/evidence-descent.test.ts`,
  present on clean HEAD) plus the known environmental FDX registry issue.