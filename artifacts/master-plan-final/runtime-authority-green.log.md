# Runtime Authority — Fail-Fast Evidence

Evidence for the single-writable-authority phase on
`feat/orchestration-master-plan-completion`.

## Change

- `RuntimeOrchestrator` and `TransitionService` no longer silently default to
  `InMemoryStateStore`. Production fails fast unless a durable store is
  configured (explicit `stateStore` or `dbPath` → SQLite); in-memory is an
  explicit `devMode: true` opt-in.
- `createTask` uses atomic `createRun` (state + contract + creation event in
  one transaction) instead of the deprecated non-atomic `saveState` +
  `recordEvent` pair.
- Removed write-only in-memory Maps that shadowed the state store.

## GREEN evidence

Captured: `bun test tests/orchestration/runtime-integration.test.ts
tests/orchestration/runtime/state-machine.test.ts`

```
bun test v1.3.14 (0d9b296a)

 198 pass
 0 fail
 312 expect() calls
Ran 198 tests across 2 files. [110.00ms]
```

- Full orchestration suite: 757 pass, 0 fail
- Typecheck (`tsc --noEmit -p tsconfig.prepush.json`): clean
- Full repo suite: 4642 pass, 2 fail — the 2 failures
  (`validateEvidenceOnlyDescent` in `tests/benchmarks/evidence-descent.test.ts`)
  are branch-state dependent (they assert the last commit is artifacts-only)
  and reproduce on clean HEAD without these changes. Pre-existing.

## Tests added

- `TransitionService` throws without a store; `devMode: true` and explicit
  `stateStore` paths work (state-machine.test.ts).
- `RuntimeOrchestrator` throws without stateStore/dbPath/devMode; `devMode`
  and `dbPath` paths work (runtime-integration.test.ts).

## ADR

`docs/architecture/integration/runtime-authority.md`
