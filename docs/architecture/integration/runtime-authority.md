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

## Verification

- `bun test tests/orchestration/` — 757 pass (includes new fail-fast
  regression tests).
- `bun tsc --noEmit -p tsconfig.prepush.json` — clean.
- Full suite: 4642 pass, 2 pre-existing unrelated failures
  (`validateEvidenceOnlyDescent` in `tests/benchmarks/evidence-descent.test.ts`,
  present on clean HEAD) plus the known environmental FDX registry issue.