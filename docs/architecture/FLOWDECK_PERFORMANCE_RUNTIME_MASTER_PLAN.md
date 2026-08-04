# FlowDeck Performance Runtime Master Plan

**Author:** Dev 2 (Performance Runtime)
**Status:** Published
**Branch:** `feat/performance-runtime-master-plan`
**Base SHA:** `5809fcf1230ff349ff0d7f5b53ed75403f44573b` (FlowDeck v1.0.3)
**Created:** 2026-08-01

---

## 1. Frozen FlowDeck v1.0.3 Harness

FlowDeck v1.0.3 (`5809fcf1230ff349ff0d7f5b53ed75403f44573b`) is the **self-hosting orchestration harness** for all performance and runtime work. No work in this plan may break or regress the v1.0.3 contract.

The harness provides:
- Orchestration core: task scheduling, run lifecycle, session management
- Streaming infrastructure: SSE transport, event emission, client negotiation
- Contract domain: verification, approval, override, completion, idempotency
- Telemetry primitives: event recording, metric snapshots
- Context management: token budgets, manifest tracking, compaction hooks

**Harness immutability:** The v1.0.3 harness is frozen. All modifications to orchestration behaviour must be additive, backward-compatible, or gated behind feature flags reviewed by Dev 2.

---

## 2. Repository Baseline

| Property | Value |
|---|---|
| SHA | `5809fcf1230ff349ff0d7f5b53ed75403f44573b` |
| Tag | `v1.0.3` |
| Release | FlowDeck v1.0.3 — Release Integrity Repair |
| npm | `@heidi-dang/flowdeck@1.0.3` |

All benchmarks, reports, and wave deliverables reference this exact SHA. No SHA drift is permitted within a wave or milestone.

---

## 3. Dev 1 SSE/UI Priority and Ownership

Dev 1 owns all work related to streaming, live UI, and client-side orchestration feedback.

### 3.1 Source Ownership

| Path | Description |
|---|---|
| `src/orchestration/streaming/**` | SSE transport, event emission, chunking, client negotiation |
| `src/better-harness/**` | SSE transport layer or live UI integration points |
| `src/ui/**` | Live orchestration dashboard |
| `src/client/**` | Streaming client, reconnect logic, SSE parser |

### 3.2 Test Ownership

| Path | Description |
|---|---|
| `tests/streaming/**` | SSE transport, chunk ordering, reconnect, backpressure |
| `tests/ui/**` | Dashboard rendering, live updates, component state |
| `tests/e2e/**` | Streaming dashboard end-to-end scenarios |

### 3.3 Feature Ownership

- SSE client implementation
- Live orchestration UI (task progress, run status, streaming output)
- Mobile streaming UI
- Streaming accessibility (ARIA live regions, screen reader support)
- Stream replay UI (playback controls, timeline scrubbing)
- Stream transport performance (latency, throughput, connection reuse)

**Interface boundary:** Dev 1 publishes to shared telemetry events. Dev 2 consumes and routes those events. Dev 1 must not modify shared interface types without Dev 2 review.

---

## 4. Dev 2 Runtime/Performance Ownership

Dev 2 owns all work related to runtime correctness, context efficiency, tool performance, and analytics. Model routing and FDX daemon work are DEPENDENCY OWNED BY DEV 4 and DEV 3 respectively.

### 4.1 Source Ownership

| Path | Description |
|---|---|
| `src/orchestration/telemetry/**` | Event recording, telemetry pipeline, metric aggregation |
| `src/orchestration/context/**` | Token budgets, manifest, deduplication, compaction |
| `src/orchestration/runtime/**` | State machine, run lifecycle, session management |
| `src/orchestration/recovery/**` | Interruption handling, checkpointing, resume |
| `src/orchestration/completion/**` | Semantic completion gates, decision logic |
| `src/orchestration/verification/**` | Contract verification, evidence collection |
| `src/orchestration/contracts/**` | Contract families, versions, activation policy |
| `src/tools/**` | Tool metadata, scheduling, batching, caching |
| `scripts/benchmark-*` | Performance benchmarking scripts |
| `scripts/report-self-host*` | Self-host reporting scripts |

**Note:** The following were removed in Dev 3/Dev 4 overlap cleanup and are now DEPENDENCY OWNED BY respective developers:
- `src/orchestration/routing/**` — DEPENDENCY OWNED BY DEV 4
- `crates/fdx/**` — DEPENDENCY OWNED BY DEV 3 (FDX daemon/index)

### 4.2 Test Ownership

| Path | Description |
|---|---|
| `tests/performance/**` | Throughput, latency, memory, CPU benchmarks |
| `tests/consistency/**` | Repeated-run consistency, deterministic output |
| `tests/recovery/**` | Interruption, checkpoint, resume scenarios |
| `tests/orchestration/**` | Runtime behaviour, state transitions, lifecycle |
| `docs/architecture/FLOWDECK_PERFORMANCE_RUNTIME_MASTER_PLAN.md` | This document |

---

## 5. Shared Interfaces

All shared interfaces are **versioned**, **runtime-validated**, and **framework-neutral**. Modifications require Dev 2 review and a minor version bump.

### 5.1 Identifier Types

| Interface | Description |
|---|---|
| `RunId` | Unique identifier for a task run |
| `SessionId` | Unique identifier for an orchestration session |
| `AssignmentId` | Unique identifier for a tool or specialist assignment |

### 5.2 Reference Types

| Interface | Description |
|---|---|
| `TaskContractRef` | Reference to a task contract family and version |

### 5.3 Enums

| Enum | Description |
|---|---|
| `RunStage` | `pending`, `running`, `paused`, `completing`, `completed`, `cancelled`, `failed` |
| `ExecutionStrategy` | `sequential`, `parallel`, `conditional`, `loop`, `scatter-gather` |

### 5.4 Telemetry Interfaces

| Interface | Description |
|---|---|
| `TelemetryEvent` | Base interface for all telemetry events with `eventType`, `runId`, `sessionId`, `timestamp` |
| `MetricSnapshot` | Point-in-time metric recording (tokens, latency, cost) |
| `ModelSelectionRecord` | Records which model was selected and why |
| `ToolInvocationRecord` | Records a single tool invocation (input, output, duration, success) |
| `SpecialistResultContract` | Contract for specialist/sub-agent results returned to the orchestrator |

### 5.5 Verification and Completion

| Interface | Description |
|---|---|
| `VerificationResult` | Outcome of contract verification (pass/fail/pending with evidence) |
| `CompletionDecision` | Final completion decision with outcome, gates passed, overrides applied |

### 5.6 State Types

| Interface | Description |
|---|---|
| `CancellationState` | Records cancellation request, propagation status, child session states |
| `RecoveryState` | Records checkpoint, last good state, recovery strategy, resume eligibility |

---

## 6. Implementation Waves with Milestones

### Wave 0: Baseline, Reports, Benchmarks

**Goal:** Establish exact-SHA baseline and reporting infrastructure.

| Milestone | Deliverable |
|---|---|
| 0.1 | `exact-SHA` validation script — verifies git SHA before and after operations |
| 0.2 | Self-host report format defined and implemented in `scripts/report-self-host*` |
| 0.3 | Performance benchmark scripts running 3 iterations per scenario at SHA `5809fcf` |
| 0.4 | Consistency benchmark running 3 iterations per scenario at SHA `5809fcf` |
| 0.5 | Wave 0 baseline report committed (latency, throughput, memory, consistency) |

**Exit criteria:** All Wave 0 scripts run cleanly at `5809fcf`. No P0/P1 issues in baseline.

---

### Wave 1: Runtime Correctness

**Goal:** Enforce runtime lifecycle in code; implement contracts, verification, completion, cancellation, and recovery.

| Milestone | Deliverable |
|---|---|
| 1.1 | State machine enforces `RunStage` transitions with invalid-transition errors |
| 1.2 | All `contracts/**` methods implement atomic writes, CAS where required, and replay-safe reads |
| 1.3 | `verification/**` collects evidence and produces `VerificationResult` per run |
| 1.4 | `completion/**` evaluates semantic completion gates; `CompletionDecision` is deeply immutable |
| 1.5 | `cancellation/**` propagates cancellation to child sessions |
| 1.6 | `recovery/**` checkpoints run state; resume recovers to last good state |
| 1.7 | `idempotency/**` `tryReserve` is atomic; no check-then-reserve race |

**Exit criteria:** All 209 contract-domain tests pass. Cancellation reaches child sessions. Recovery survives interruption. 0 P0/P1 runtime issues.

---

### Wave 2: Context and Token Efficiency

**Goal:** Reduce redundant context; implement budgets, deduplication, and compaction.

| Milestone | Deliverable |
|---|---|
| 2.1 | Context manifest tracks all context entries per run with size estimates |
| 2.2 | Token budgets enforced per run stage; over-budget triggers compaction or rejection |
| 2.3 | Context deduplication eliminates repeated system prompts, tool descriptions, and prior results |
| 2.4 | Context compaction compresses older history entries when budget threshold is reached |
| 2.5 | Redundant context reduced measurably (target: ≥30% token reduction on repeated-run scenarios) |

**Exit criteria:** Context budgeting active. Deduplication active. Compaction active. ≥30% token reduction on repeated runs.

---

### Wave 3: Heidi and Routing Intelligence

**Goal:** Implement classifier, strategy selection, capability registry, delegation, and scheduler.

**Status:** DEPENDENCY OWNED BY DEV 4 — routing and scheduling intelligence is owned by Dev 4.

| Milestone | Deliverable |
|---|---|
| 3.1 | Task type classifier routes incoming tasks to appropriate `ExecutionStrategy` |
| 3.2 | Capability registry lists all models and specialists with their capability tiers |
| 3.3 | Delegation engine assigns work to appropriate model or specialist based on task profile |
| 3.4 | Scheduler respects priority, deadline, and capacity constraints |
| 3.5 | Routing decisions are measurable and deterministic (logged to `ModelSelectionRecord`) |

**Exit criteria:** Classifier operational. Registry complete. Routing measurable and deterministic.

---

### Wave 4: Model Routing

**Goal:** Implement capability tiers, routing policy, provider health, and structured outputs.

**Status:** DEPENDENCY OWNED BY DEV 4.

| Milestone | Deliverable |
|---|---|
| 4.1 | Model capability tiers defined (reasoning, speed, cost, context window, tool use) |
| 4.2 | Routing policy selects model based on task requirements and tier capabilities |
| 4.3 | Provider health monitoring tracks latency, error rate, and availability per model |
| 4.4 | Structured output enforcement ensures model responses parse correctly |
| 4.5 | Model routing measurable: routing policy decisions logged and reportable |

**Exit criteria:** Capability tiers defined. Routing policy active. Provider health tracked. Structured outputs enforced.

---

### Wave 5: FDX and Tool Performance

**Goal:** Optimize FDX daemon, warm indexes, tool batching, caching, and scheduling.

**Status:** DEPENDENCY OWNED BY DEV 3 — FDX daemon and index optimization is owned by Dev 3.

| Milestone | Deliverable |
|---|---|
| 5.1 | FDX daemon starts in <2s for warm operation |
| 5.2 | Warm indexes preloaded for frequent tools; cold start cases handled gracefully |
| 5.3 | Tool batching groups independent tool calls; batching is safe (no order dependency) |
| 5.4 | Tool result caching eliminates redundant invocations for identical inputs |
| 5.5 | Tool scheduler balances throughput and resource usage under load |
| 5.6 | FDX warm operation meets token and latency budgets |

**Exit criteria:** FDX warm operation <2s. Batching and caching safe. Scheduler respects budgets.

---

### Wave 6: Analytics and Adaptive Recommendations

**Goal:** Implement agent analytics, model analytics, and redundancy detection.

| Milestone | Deliverable |
|---|---|
| 6.1 | Agent analytics track per-agent throughput, error rate, and cost |
| 6.2 | Model analytics track per-model latency, cost, accuracy, and structured output rate |
| 6.3 | Redundancy detection identifies repeated context, duplicate tool calls, and wasted tokens |
| 6.4 | Adaptive recommendations surface efficiency opportunities to operators |

**Exit criteria:** Analytics active. Redundancy detection operational. Recommendations actionable.

---

### Wave 7: Evaluation and Hardening

**Goal:** Repeated-run consistency, trace replay, fault injection, and production gate.

| Milestone | Deliverable |
|---|---|
| 7.1 | Repeated-run consistency: same task produces equivalent outcomes across runs |
| 7.2 | Trace replay: audit log can replay a run from event stream exactly |
| 7.3 | Fault injection: chaos testing covers network partitions, provider outages, and memory pressure |
| 7.4 | Production gate: all P0/P1 issues resolved; all benchmark targets met |
| 7.5 | Final self-host report demonstrates all targets met at final SHA |

**Exit criteria:** All P0/P1 issues closed. Consistency verified. Production gate passes.

---

## 7. Dependency Order Between Waves

```
Wave 0 (Baseline)
        │
        ▼
Wave 1 (Runtime Correctness) ←─┐
        │                      │
        ▼                      │
Wave 2 (Context Efficiency) ───┤
        │                      │
        ▼                      │
Wave 3 (Heidi & Routing) ─────┤
        │                      │
        ▼                      │
Wave 4 (Model Routing) ───────┤
        │                      │
        ▼                      │
Wave 5 (FDX & Tool Perf) ──────┤
        │                      │
        ▼                      │
Wave 6 (Analytics) ────────────┤
        │                      │
        ▼                      │
Wave 7 (Evaluation & Hardening)
```

**Dependency rules:**
- Each wave requires the previous wave's exit criteria to be met.
- Waves 2–7 may begin after Wave 1 exit criteria are verified.
- Wave 5 (FDX) may proceed independently of Wave 4 (Model Routing) once Wave 1 is complete.
- Wave 6 (Analytics) requires Waves 2, 4, and 5 to be operational before meaningful data is available.
- Wave 7 requires all preceding waves to be operational.

---

## 8. Performance Targets

| Target | Metric | Threshold |
|---|---|---|
| FDX warm operation | Daemon start time | <2s |
| FDX warm operation | Tool index preload | <500ms |
| Tool batching | Batch formation latency | <50ms |
| Tool caching | Cache hit ratio | ≥80% for repeated inputs |
| Model routing | Routing decision latency | <10ms |
| Context budgeting | Over-budget rejection | Graceful (no crash) |
| Context compaction | Token reduction on repeated runs | ≥30% |
| Redundant context | Waste tokens eliminated | Measurable reduction |
| Model and specialist routing | Decision determinism | Logged and reproducible |
| Telemetry pipeline | Event recording latency | <5ms per event |

---

## 9. Stability Targets

| Target | Requirement |
|---|---|
| Runtime lifecycle | `RunStage` transitions enforced in code; invalid transitions throw |
| exact-SHA verification | SHA validated before and after every operation; mismatch fails fast |
| Semantic completion gates | All gates evaluated; no silent pass on failure |
| Cancellation propagation | Cancellation reaches all child sessions within one event loop tick |
| Recovery survival | Resume recovers to last checkpoint; no data loss on interruption |
| P0/P1 issues | Zero P0/P1 issues remain at Wave 7 exit |
| Contract domain | All 209 contract-domain tests pass continuously |
| Immutability | CompletionDecision, ApprovalDecision, Evidence are deeply immutable |
| Idempotency | No check-then-reserve race; `tryReserve` is atomic |

---

## 10. Benchmark Rules

### 10.1 Iteration Requirements

| Phase | Iterations per scenario |
|---|---|
| Baseline (Wave 0) | 3 |
| Milestone comparison | 5 |
| Final sign-off (Wave 7) | 5 |

### 10.2 Benchmark Methodology

1. **Cold reset:** Each iteration starts from a clean state (no warm cache unless measuring cache hit ratio).
2. **Isolation:** Benchmarks run sequentially; no parallel workloads on the same host.
3. **Exact SHA:** Benchmark scripts validate git SHA before and after; SHA drift invalidates results.
4. **Warm-up:** First iteration is discarded (JIT, cold start effects).
5. **Reporting:** Report median, p95, and p99 for latency; report mean for throughput.

### 10.3 Scenarios

| Scenario | Metric |
|---|---|
| FDX cold start | Time to first tool invocation |
| FDX warm operation | Time per tool invocation with warm cache |
| Tool batching | Latency per tool call with batching enabled |
| Tool caching | Cache hit ratio, latency reduction on cache hit |
| Context compaction | Token reduction percentage |
| Repeated-run consistency | Output similarity score |
| Cancellation propagation | Time to signal child sessions |
| Recovery from checkpoint | Time to resume interrupted run |
| Model routing decision | Routing decision latency |
| Telemetry event recording | Event recording latency |

---

## 11. Required Tests

### 11.1 Test Categories

| Category | Coverage Requirement |
|---|---|
| Unit tests | All public methods on owned modules |
| Negative tests | Invalid inputs, malformed contracts, impossible transitions |
| Regression tests | All historical bugs must have a regression test |
| Concurrency tests | Concurrent read/write, CAS collisions, race conditions |
| Cancellation tests | Cancellation propagation to child sessions |
| Error-path tests | All error codes emitted, all errors handled |
| Deterministic serialization tests | Serialized output is stable across runs |
| exact-SHA tests | SHA is validated at test setup and teardown |

### 11.2 Critical Test Files

| File | Tests | Focus |
|---|---|---|
| `tests/orchestration/runtime/state-machine.test.ts` | ≥20 | Valid/invalid transitions |
| `tests/orchestration/contracts/*.test.ts` | ≥65 | Contract lifecycle, CAS, atomicity |
| `tests/orchestration/verification/*.test.ts` | ≥37 | Evidence collection, SHA binding |
| `tests/orchestration/completion/*.test.ts` | ≥46 | Semantic gates, decision immutability |
| `tests/orchestration/idempotency/*.test.ts` | ≥14 | tryReserve atomicity, replay |
| `tests/recovery/*.test.ts` | ≥15 | Checkpoint, resume, interruption |
| `tests/consistency/*.test.ts` | ≥10 | Repeated-run determinism |
| `tests/performance/*.test.ts` | ≥10 | Throughput, latency, memory |

---

## 12. PR Strategy

### 12.1 Size Limits

| Rule | Limit |
|---|---|
| Changed files per PR | <15 |
| Stacked branch depth | ≤5 branches |
| Reviewers required | 1 (Dev 2 self-merge for owned paths) |

### 12.2 Branch Naming

```
feat/performance-runtime/wave-N/milestone-description
fix/performance-runtime/wave-N/issue-description
chore/performance-runtime/wave-N/task-description
```

### 12.3 PR Requirements

- [ ] Branched from exact SHA (validated in CI)
- [ ] All required tests pass (unit, negative, concurrency, error-path)
- [ ] Benchmark scripts updated if performance-affecting
- [ ] Self-host report updated if runtime-affecting
- [ ] No P0/P1 issues introduced
- [ ] Dev 2 review for shared interface changes
- [ ] Changelog entry per wave milestone

### 12.4 Stacked Branches

```
main
└── feat/performance-runtime/wave-0/baseline
    └── feat/performance-runtime/wave-1/runtime-correctness
        └── feat/performance-runtime/wave-2/context-efficiency
            └── ...
```

Each branch is PR'd against its parent. The final wave PR is against `main`.

---

## 13. Self-Host Report Format

### 13.1 Report Structure

```markdown
# Self-Host Report — [Wave N] — [Milestone]

**SHA:** [exact 40-char SHA]
**Branch:** [branch name]
**Run date:** [ISO 8601]
**Runner:** [hostname or CI runner]

## Environment
- OS: [os release]
- Node/Bun version: [version]
- Memory: [total RAM]
- CPU: [model, core count]

## Baseline SHA Comparison
| Metric | Baseline (5809fcf) | This SHA | Delta |
|---|---|---|---|
| [metric] | [value] | [value] | [% or absolute] |

## Performance
| Scenario | Iterations | Median | p95 | p99 |
|---|---|---|---|---|
| [scenario] | [N] | [ms] | [ms] | [ms] |

## Stability
| Check | Status |
|---|---|
| exact-SHA validation | PASS/FAIL |
| Runtime lifecycle | PASS/FAIL |
| Cancellation propagation | PASS/FAIL |
| Recovery survival | PASS/FAIL |
| P0/P1 issues | [count] open |

## Telemetry
| Event type | Count | Drop rate |
|---|---|---|
| [event] | [N] | [%] |

## Sign-off
- [ ] Dev 2 review
- [ ] Performance targets met
- [ ] Stability targets met
```

### 13.2 Rollout Requirements

| Phase | Requirement |
|---|---|
| Pre-rollout | All Wave N milestone criteria met |
| Pre-rollout | Self-host report published and reviewed |
| Pre-rollout | No P0/P1 issues open |
| Rollout | Canary deployment to 5% of hosts |
| Rollout | Monitor for 24h; no error rate increase |
| Full rollout | 100% deployment after canary success |
| Post-rollout | Self-host report updated with production metrics |

### 13.3 Rollback Requirements

| Trigger | Action |
|---|---|
| Error rate increase >1% | Rollback to previous SHA |
| Latency increase >20% | Rollback to previous SHA |
| P0/P1 issue introduced | Rollback to previous SHA |
| exact-SHA validation failure | Rollback immediately; do not proceed |

Rollback is a single `git reset --hard` to the previous SHA plus a fresh deployment. No partial rollback of individual files is permitted.

---

## 14. Production Runtime Integration

**Status:** Integrated (2026-08-01)

### 14.1 Integration Overview

Dev 2 runtime modules (runtime state machine, contract validation/store, verification executor, completion engine, cancellation service, recovery strategies, context budgets, and telemetry) have been wired through the production execution path via `src/orchestration/runtime-integration.ts` and exported through `src/orchestration/index.ts`.

### 14.2 RuntimeOrchestrator API

The `RuntimeOrchestrator` class provides a unified interface covering all integration points:

| Method | Integration Point | Description |
|---|---|---|
| `createTask(contractData)` | Contract Activation | Validates and activates an immutable `TaskContract`, persists to `ContractStore`, initializes `StateStore` state |
| `transition(runId, event, fromState?)` | Transition Events | Loads authoritative state from `StateStore`, validates transition matrix + guards, persists state + event atomically via `TransitionService` |
| `verify(runId)` | Verification Plans | Builds a `VerificationPlan` from the contract's `requiredVerification` requirements and executes through `VerificationExecutor` |
| `complete(runId)` | Completion | Evaluates contract-derived completion gates via `CompletionEngine`; model report cannot bypass gates |
| `cancel(runId, force?)` | Cancellation | Propagates cancellation to active child work via `CancellationService` token tree |
| `recover(runId)` | Recovery | Restores run state from persisted `Checkpoint` in `StateStore`; state persists across process restart |
| `getContextBudget(runId)` | Context Budgets | Returns a `ContextBudget` derived from contract configuration for agent execution |
| `subscribe(listener)` | Telemetry | Event subscription for runtime events (transitions, verification, completion, cancellation, recovery) |

### 14.3 Wiring Details

- **StateStore:** `InMemoryStateStore` used as default; `TransitionService` shares the same `StateStore` to load authoritative state for each transition
- **Contract Store:** `ContractStore` (immutable in-memory) used as default; `activateContract` validates and freezes contracts before persistence
- **Transition Events:** `TransitionService` persists `TransitionEvent` records alongside state updates via `StateStore.recordEvent()` — same unit of work
- **Verification:** `VerificationExecutor` constructed with injected `Clock`; plans built from contract `requiredVerification` fields
- **Completion:** `CompletionEngine` evaluates all 6 semantic gates; input built from contract `acceptanceCriteria`, `requirements`, `requiredEvidence`, and `startingSha`
- **Cancellation:** `CancellationService` manages token tree; root token created per run; `cancel()` propagates to child tokens and transitions state to `cancelled`
- **Recovery:** `RecoveryState` and `Checkpoint` persisted via `CancellationService` checkpoint repository; `recover()` evaluates strategy via `determineRecoveryStrategy` and restores from checkpoint
- **Context Budget:** `createBudget()` initializes budget from `RuntimeConfig.contextBudgetTokens` (default 200000); `addMandatoryCost`, `addHighValueCost`, `addOptionalCost` applied during agent execution (caller responsibility)
- **Telemetry:** All runtime events published through `subscribe()` as `RuntimeEvent` objects; `StageEventEmitter` events also forwarded

### 14.4 New File

| File | Purpose |
|---|---|
| `src/orchestration/runtime-integration.ts` | `RuntimeOrchestrator` class and supporting types (`RuntimeConfig`, `RuntimeEvent`, `RuntimeEventListener`, `Unsubscribe`, `RecoveryResult`, `CompletionResult`) |

### 14.5 Modified File

| File | Change |
|---|---|
| `src/orchestration/index.ts` | Added exports for `RuntimeOrchestrator`, `RuntimeConfig`, runtime events, `Unsubscribe`; re-exports from `./runtime`, `./completion`, `./context` dev2 sub-modules |

### 14.6 Files Not Modified (Ownership)

- Dev 1: `src/orchestration/streaming/**`, `src/better-harness/**`, `src/ui/**`, `src/client/**`
- Dev 3: `crates/fdx/**`, FDX daemon and index code
- Dev 4: `src/orchestration/routing/**` (if present), model routing and scheduling code

---

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-08-01 | Dev 2 | Initial publication |
| 2026-08-01 | Dev 2 | Dev 3/Dev 4 overlap removal: marked routing (Dev 4), model routing (Dev 4), FDX daemon/index (Dev 3) as dependencies; removed orphaned routing directory |
| 2026-08-01 | Dev 2 | Production runtime integration: RuntimeOrchestrator wired through `src/orchestration/index.ts`; Dev 2 runtime modules (runtime, contracts, verification, completion, recovery, context, telemetry) now exported via orchestration entrypoint; StateStore, ContractStore, TransitionService, VerificationExecutor, CompletionEngine, CancellationService, ContextBudget unified in `src/orchestration/runtime-integration.ts` |
