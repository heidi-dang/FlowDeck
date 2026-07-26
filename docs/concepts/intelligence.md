# Intelligence

FlowDeck's intelligence layer provides scaffolding for evaluating changes. It includes tools for risk analysis, failure replay, and rule compliance, and uses guard rails to enforce planning discipline. These services run through tools and hooks where implemented.

---

## Patch Trust Score

The patch trust score is a risk signal computed during governance hooks:

- **80+** — safe; edits proceed
- **60–79** — review recommended
- **< 60** — approval required before proceeding

## Failure Replay

The `failure-replay` tool reproduces prior failures from stored context. It is invoked by `@debug-specialist` to generate a diagnostic trace.

## Phase Gating

Phase gating enforces workflow discipline by blocking certain tool invocations when planning prerequisites are not met. The `guard-rails` hook (`tool.execute.before`) checks `STATE.md` for plan confirmation and workspace initialization.

## Intelligence Tool Summary

| Tool / Hook | Purpose |
|-------------|---------|
| `failure-replay` | Reproduce and trace prior failures |
| `policy-engine` | Evaluate edits against project rules |
| `guard-rails` hook | Enforce planning discipline and execution mode |
| `doctor` | Health diagnostics across environment, configuration, and contracts |
