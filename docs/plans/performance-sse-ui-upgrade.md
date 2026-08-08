# FlowDeck Performance, Stability, and SSE UI Upgrade

## Status

- **Owner:** Dev 1 — performance and UI foundation integrator
- **Branch:** `feat/performance-sse-ui-foundation`
- **Base SHA:** `5809fcf1230ff349ff0d7f5b53ed75403f44573b`
- **Frozen orchestration harness:** FlowDeck **v1.0.3**
- **Target repository baseline:** FlowDeck `main` at the base SHA above
- **Architecture baseline:** `NEXT_GEN_ARCHITECTURE_v0.2.6.md`
- **Canonical schema:** `schema-v0.2.6.sql`
- **Merge policy:** keep the branch and PR open; do not merge or release without human approval

The FlowDeck v1.0.3 harness is frozen for the entire campaign. Candidate builds may run only in isolated shadow, replay, benchmark, UI, or fault-test environments until the final release gate. The campaign must not silently replace its own baseline while measuring performance.

## Objective

Upgrade FlowDeck as a complete execution platform rather than applying isolated prompt or visual changes. The program covers five performance dimensions:

1. **Execution latency** — reduce time to useful work and completion.
2. **Token efficiency** — reduce repeated and irrelevant model context.
3. **Correctness and consistency** — enforce lifecycle, verification, evidence, and completion rules in runtime code.
4. **Recoverability** — survive cancellation, process loss, provider failure, and browser reconnect.
5. **Perceived performance** — provide an accurate, useful live UI during long-running work.

Every implementation task must report both the code result and the performance/stability of the frozen FlowDeck v1.0.3 harness used to execute it.

## Release targets

| Metric | Target |
|---|---:|
| Orchestration startup overhead, excluding provider latency | p95 under 300 ms |
| First visible run event in UI | p95 under 250 ms |
| Backend event to browser render | p95 under 150 ms |
| Warm FDX metadata query | p95 under 40 ms |
| Warm FDX symbol/search query | p95 under 100 ms |
| Redundant tool calls | Reduce by at least 40% |
| Median input tokens per successful task | Reduce by 40–60% |
| Median cost per successful task | Reduce by at least 35% |
| Unnecessary specialist sessions | Reduce by at least 30% |
| Verification for non-trivial changes | 100% |
| Completion bound to exact repository SHA | 100% |
| Recoverable interrupted runs | At least 99% in fault tests |
| SSE reconnect without missing or duplicated required state | 100% |
| Equivalent repeated-run outcomes | At least 90% |
| Longest unexplained UI silence | No more than five seconds |
| UI render performance | 60 FPS under normal event load |
| Mandatory production suites | No skipped or excluded orchestration suites |

These are release gates. A faster execution that increases repair cycles, verification failures, or false completion is a regression.

## Architecture direction

```text
User request
  -> task classifier
  -> contract compiler
  -> strategy selector
  -> context builder
  -> runtime state machine
  -> agent/tool scheduler
  -> verification and evidence
  -> completion gate
  -> persisted event projections
       -> SSE UI
       -> metrics
       -> recovery
       -> adaptive routing
```

The v0.2.6 SQLite model remains the source of truth. Reuse the existing session, model, context, event, outbox, delivery, checkpoint, recovery, and completion tables. Do not create a parallel analytics database or unrelated run-state model.

## Dev 1 ownership

Dev 1 owns the initial cross-cutting foundation required before the specialist workstreams can proceed:

- Freeze and document the v1.0.3 self-hosting baseline.
- Define shared telemetry and performance contracts.
- Define the canonical SSE v2 event envelope.
- Define a framework-neutral UI run projection.
- Add deterministic tests for telemetry, event sequencing, progress, and UI state.
- Establish the first self-host performance report format.
- Prepare integration seams for runtime state, persistence, streaming delivery, and the future visual dashboard.

Dev 1 does **not** own every later implementation. After shared contracts are stable, work will split as follows:

| Owner | Scope |
|---|---|
| Dev 1 | Runtime integration, shared contracts, completion/recovery integration |
| Dev 2 | Context budgets, compaction, summaries, token accounting |
| Dev 3 | FDX daemon, indexes, batching, caches |
| Dev 4 | Classification, delegation, scheduler, model router |
| Dev 5 | Event delivery, SSE replay, snapshots, backpressure |
| Dev 6 | Full visual dashboard, mobile behaviour, accessibility |
| Dev 7 | Benchmarks, trace replay, load, fault, and consistency testing |
| Gatekeeper | Cross-workstream architecture and final audit only |

## First milestone

The first production milestone is intentionally narrow:

1. Unified run telemetry.
2. Code-enforced runtime lifecycle integration seam.
3. Exact-SHA verification and completion integration seam.
4. Context/token accounting integration seam.
5. SSE v2 event contract.
6. Minimal live stage/activity UI projection.

A user-visible renderer is not required in the first commit. The first commit must provide stable contracts and testable projections so the backend and UI can evolve without incompatible event models.

## Initial implementation slice

Create:

```text
src/orchestration/performance/contracts.ts
src/orchestration/performance/run-profiler.ts
src/orchestration/performance/index.ts
src/orchestration/streaming/stream-event.ts
src/orchestration/streaming/index.ts
src/orchestration/ui/run-activity-projection.ts
src/orchestration/ui/index.ts
tests/orchestration/performance-sse-ui-foundation.test.ts
```

The initial slice must provide:

- Stable stage and strategy identifiers.
- Trace dimensions including run, session, assignment, agent, model, tool, repository, and SHA.
- Deterministic operation spans and a queryable run waterfall.
- Separate timing categories for orchestration, provider, model generation, tool queue, tool execution, verification, persistence, SSE delivery, UI rendering, and human approval.
- Token, cache, cost, and tool-count aggregation without storing prompts.
- A canonical stream event envelope with monotonic sequence support.
- Event families for runs, tasks, contracts, stages, plans, agents, tools, models, verification, recovery, evidence, approvals, metrics, and heartbeats.
- Progress that exists only when the runtime has a real completed/total unit.
- A UI projection exposing stage rail state, current operation, active agents, verification progress, metrics, reconnect state, and terminal status.
- Deduplication by event ID and rejection of conflicting sequence reuse.
- Unit tests with an injected clock and deterministic timestamps.

## FlowDeck execution requirements

Every non-trivial task must use:

```text
fd-task -> fd-review -> fd-execute -> fd-verify -> fd-done
```

For each task:

1. Load planning state and the latest checkpoint.
2. Load repository rules and relevant memory.
3. Use FDX for focused repository discovery.
4. Record the execution strategy in `fdx-decisions`.
5. Delegate only for independent ownership, required expertise, or independent review.
6. Append specialist outcomes to `fdx-context`.
7. Save a checkpoint after every stage.
8. Run focused verification before broad verification.
9. Bind evidence and CI to the exact remote SHA.
10. Generate the implementation and FlowDeck self-host report.

Maximum automatic delegation depth remains exactly one. Specialists cannot delegate and Heidi cannot delegate to itself.

Do not call every FlowDeck feature performatively. Use each feature only when it contributes to the task, and mark non-applicable capabilities in the task report.

## Context and token policy

Every model or specialist request must receive only:

- Active objective.
- Acceptance criteria.
- Exact file and symbol references.
- Repository SHA.
- Current stage.
- Constraints.
- Relevant evidence.

Do not repeatedly send entire files, full CI logs, completed stage transcripts, unchanged rules, or architecture documents. Store large output as an artifact and pass a bounded summary plus reference.

Track input tokens, output tokens, reasoning tokens where available, cache reads/writes, context bytes, compactions, duplicated context, and token-budget breaches. Missing metrics must be reported as `not instrumented`; they must never be fabricated.

## SSE v2 contract

The UI consumes persisted domain-event projections, not ad hoc console text.

Required properties:

- Unique event ID.
- Monotonic sequence per run.
- Run ID and optional session/assignment IDs.
- Timestamp.
- Event type.
- Stage.
- Importance.
- Title and bounded summary.
- Typed payload.
- Optional real progress.
- Optional metrics.

Required delivery behaviour in later slices:

- Persist before delivery.
- Replay using `Last-Event-ID` or an explicit sequence.
- Deduplicate by event ID.
- Detect sequence gaps.
- Serve snapshots when replay is too large.
- Send heartbeats without UI noise.
- Coalesce low-priority token and metric updates.
- Never drop errors, approvals, evidence, cancellation, or completion events.
- Propagate cancellation to children, tools, and model streams.

No fake percentages and no chain-of-thought streaming are permitted.

## Long-task UI requirements

The final dashboard must answer continuously:

1. What is FlowDeck doing?
2. Why is it doing it?
3. What has completed?
4. Does the user need to act?

Planned components:

- Run header.
- Stage rail.
- Current-operation card.
- Activity timeline.
- Agent activity grid.
- Grouped tool activity.
- Verification panel.
- Evidence drawer.
- Metrics bar.
- Decision timeline.
- Recovery banner.
- Approval card.
- Reconnect banner.
- Completion summary.

The UI must support mobile layouts, keyboard navigation, visible focus, reduced motion, screen readers, bounded timeline memory, and calm attention states. Routine work must not use distracting animation.

## Mandatory per-task report

Every completed task must return a report containing:

### Identity

- Task ID and phase.
- Campaign ID.
- FlowDeck session and child-session IDs.
- Branch.
- Base, starting, local, remote, and verification SHAs.
- PR number/state.
- Frozen v1.0.3 harness identity.
- Candidate identity when evaluated.

### Implementation

- Objective.
- Root cause or architectural requirement.
- Files changed.
- Requirements and acceptance criteria.
- Known risks.
- Remaining work.
- Production-readiness score.

### Orchestration

- Strategy.
- Stage timestamps and durations.
- Specialists and ownership.
- Checkpoints.
- Decisions and context records.
- Recovery cycles.
- Guard blocks.
- Human gates.

### Tokens and cost

For Heidi and every specialist:

- Resolved model/provider.
- Input, output, and reasoning tokens where available.
- Cache reads/writes.
- Estimated cost.
- Context size/utilization.
- Compaction count.
- Repeated-context estimate.

### Tools

- Total, successful, failed, blocked, retried, and cancelled calls.
- Cache hits/misses.
- Native FDX and fallback counts.
- Bash calls.
- Five slowest operations.
- Suspected redundant calls.
- Output bytes and truncation.
- p50/p95 when the sample supports them.

### Performance

- Wall time.
- Active time.
- Provider wait.
- Tool wait.
- Verification and CI wait.
- First useful action.
- First visible event.
- Longest unexplained silence.
- Specialist startup latency.
- Parallelism and estimated benefit.
- Delegation overhead.

### Stability

Exact counts for crashes, unhandled errors, hangs, timeouts, orphans, correlation ambiguity, missed checkpoints, stale verification, duplicate/missing/out-of-order events, reconnect failures, repeated identical commands, leaked ownership, unintended files, cleanup failures, and CI reruns.

### SSE/UI

Events emitted/persisted/delivered/replayed, duplicates, sequence gaps, reconnects, time to first event, event-to-render latency, coalesced updates, longest UI silence, memory trend, FPS, and accessibility failures. Before instrumentation exists, use `not instrumented`.

### Dual verdict

```text
Task implementation readiness: X/10
FlowDeck v1.0.3 execution quality: X/10
FlowDeck v1.0.3 performance: X/10
FlowDeck v1.0.3 stability: X/10
Candidate comparison: improved | neutral | regressed | not yet available
Merge recommendation: ready | not ready
```

No score may exceed the available evidence.

## Performance regression policy

Block completion for an unexplained comparable regression greater than:

- 10% median latency.
- 20% p95 latency.
- 15% input or output tokens.
- 20% tool calls.
- 20% specialist count.

Also block for any increase in FDX fallback rate, required SSE event loss/reordering, stale-SHA acceptance, missing mandatory evidence, unrecoverable checkpoint, accessibility regression, production-test regression, or coverage regression.

A correctness-required regression needs a documented reason, a repair task, and human acceptance when release-blocking.

## Test requirements

The initial slice requires:

- Deterministic profiler tests.
- Duplicate span protection.
- Token/cost/tool aggregation tests.
- Stream event validation.
- Sequence and event-ID conflict tests.
- Real-progress validation.
- UI stage projection.
- Agent lifecycle projection.
- Verification progress projection.
- reconnect and terminal state projection.
- No-fake-progress regression coverage.

Before push, run applicable focused tests followed by:

```bash
npm run build
npm run lint
npm run typecheck
npm run validate:docs
npm run validate:skills
npm test
npm run test:coverage
npm run test:persistence
npm run test:orchestration:all
npm run verify:orchestration:schema
npm run validate:orchestration:artifacts
npm audit --omit=dev
npm audit
npm pack --dry-run
```

Do not hide failures with `|| true` and do not claim commands that were not run.

## Planned PR sequence

1. Performance benchmark and telemetry foundation.
2. Runtime lifecycle enforcement.
3. Contract, verification, and completion integration.
4. Recovery and cancellation.
5. Context budget and manifest.
6. Context compaction and summaries.
7. FDX daemon and warm indexes.
8. Tool batching and caching.
9. Deterministic task/risk classifier.
10. Delegation and specialist scheduler.
11. Model router.
12. SSE v2 persisted event projection.
13. Durable replay/reconnect/backpressure.
14. Live run dashboard.
15. Mobile and accessibility.
16. Agent/model analytics.
17. Repeated-run consistency and trace replay.
18. Load, soak, and fault hardening.
19. Feature flags, shadow mode, rollout, and rollback controls.

Do not combine the entire program into one PR.

## Prohibited implementations

- Fake progress percentages.
- Raw chain-of-thought display.
- Prompt-only completion rules.
- Infinite automatic retries.
- Multiple agents solving the same implementation by default.
- Full-repository context injection.
- Stateful permanent arbitrary shell.
- Unbounded SSE token events.
- Animation disconnected from real work.
- A second orchestration database.
- Adaptive routing before deterministic telemetry.
- Benchmarks without fixed fixtures.
- Caching without SHA and dirty-tree invalidation.
- Completion based only on an agent report.

## Completion rule

The branch is ready for review only when the first slice has production code, regression tests, exact-SHA CI evidence, a clean working tree, and a complete FlowDeck v1.0.3 self-host performance/stability report. Do not merge or release.