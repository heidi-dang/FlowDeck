# Heidi Fast Harness v1 — Implementation Plan

**Branch:** `feat/heidi-fast-harness-v1`  
**Spec Reference:** `docs/superpowers/specs/2026-08-18-heidi-fast-harness-v1-design.md`  
**Date:** 2026-08-18  

---

## Milestone Execution Order

### Milestone A: Instrumentation & Baseline Measurement
- [x] Task A1: Implement `HeidiPerformanceTracker` (`src/services/heidi-performance.ts`) for zero-overhead span/latency tracking.
- [x] Task A2: Add unit tests (`tests/heidi-performance.test.ts`) testing timer accuracy, metrics calculations, CoT sanitization, and $<1\text{ ms}$ p50 overhead.
- [x] Task A3: (tests/heidi-fast-harness-benchmark.test.ts + scripts/bench-fast-harness.ts; legacy numbers measured on main baseline c8762663 where available, otherwise honest current measurements) Create automated baseline runner (`tests/heidi-fast-harness-baseline.test.ts`) measuring the 10 canonical representative task types.

### Milestone B: Fast Router + FAST_DIRECT + Immediate Specialist Delegation
- [x] Task B1: Implement `HeidiFastRouter` (`src/services/heidi-fast-router.ts`) with deterministic classification (`FAST_DIRECT`, `SPECIALIST`, `PARALLEL_SPECIALISTS`, `STANDARD`, `DEEP`, `SECURITY`, `UI`, `RELEASE`).
- [x] Task B2: Add unit tests (`tests/heidi-fast-router.test.ts`) verifying instant Turn 1 routing for small fixes, failing test debugs, security audits, UI tasks, and parallel sub-tasks.
- [x] Task B3: (chat.message per-turn classification; see closure section) Wire fast router into Heidi task lifecycle.

### Milestone C: Prompt Reduction & Lazy Context / Specialist Loading
- [x] Task C1: Refactor `src/agents/orchestrator.ts` to split permanent prompt ($< 900$ tokens) from lazy-loaded catalogs (specialists, workflow stages, domain workflows).
- [x] Task C2: Implement dynamic prompt builder that excludes the specialist directory during `FAST_DIRECT` and injects targeted specialist routes on demand.
- [x] Task C3: Add unit tests (`tests/heidi-prompt-reduction.test.ts`) verifying $\ge 60\%$ token reduction and dynamic route injection.

### Milestone D: Concurrent Repository Reads & Compact Tool Packets
- [x] Task D1: Implement `ReadBatchService` (`src/services/read-batch.ts`) for parallel safe repository inspection (`fdx-read`, `fdx-grep`, `fdx-search`, `fdx-outline`).
- [x] Task D2: (compact structured packets via ReadBatchService format + prefetch summary) Implement output summarizer/compactor for tool results before injection into model context.
- [x] Task D3: Add unit tests (`tests/read-batch.test.ts`) verifying concurrent execution speedup and strict serialization of mutating operations.

### Milestone E: Externalized Task State & Repository Hot Context
- [x] Task E1: Implement `HeidiTaskState` (`src/services/heidi-task-state.ts`) tracking compact semantic state outside conversation history.
- [x] Task E2: Implement `RepositoryHotContext` (`src/services/repository-hot-context.ts`) caching root, HEAD SHA, branch, language, commands, layout, and FDX status with Git HEAD and manifest change invalidation.
- [x] Task E3: Add unit tests (`tests/heidi-task-state.test.ts`, `tests/repository-hot-context.test.ts`).

### Milestone F: Configuration & Governance Fast-Path Caching
- [x] Task F1: (resolveGovernanceModeCached consumed by tool.execute.before hot path) Implement `ConfigCache` (`src/services/config-cache.ts`) for zero-disk-read FlowDeck config, supervisor config, and agent models.
- [x] Task F2: Implement `GovernanceFastPath` (`src/services/governance-fast-path.ts`) for $< 5\text{ ms}$ (target $< 2\text{ ms}$) read-only policy authorization.
- [x] Task F3: Add unit tests (`tests/config-cache.test.ts`, `tests/governance-fast-path.test.ts`) proving full policy enforcement on writes and instant bypass for reads.

### Milestone G: Hot Path Persistence & Token Index Optimization
- [x] Task G1: (FileTokenUsageStore hot index: JSONL read once, incremental in-memory updates) Update `TokenUsageStore` / `InMemoryTokenUsageStore` in `src/services/token-usage-store.ts` with in-memory lookup index.
- [x] Task G2: Add unit tests (`tests/token-usage-hot-path.test.ts`) proving $O(1)$ query time and background durability.

### Milestone H: Deterministic Tool-Call Repair & Provider Cache Stabilization
- [x] Task H1: (wired into tool.execute.before with tool_call_repaired audit) Implement `ToolCallRepairService` (`src/services/tool-call-repair.ts`) for mechanical alias and argument normalization without model round-trips.
- [x] Task H2: (stable lean core prompt kept static and cache-stable; provider KV prefix stability retained) Ensure stable prefix structure in provider payloads to maximize provider-side KV caching.
- [x] Task H3: Add unit tests (`tests/tool-call-repair.test.ts`).

### Milestone I: Comprehensive Benchmark, Regression & Verification Gates
- [x] Task I1: (see benchmark section; Hermes comparison NOT AVAILABLE — no Hermes harness exists in this environment, results would be fabricated) Execute comparative benchmarks (isolated same-model & real-world mode).
- [x] Task I2: Run full verification gates (lint, typecheck, build, test, coverage, doctor, doctor fix, FDX parity, pre-push full).
- [x] Task I3: (merge into main after gates pass) Merge into `main` and confirm green remote CI.


## Closure (live wiring — commit 083ade9 follow-up)

- [x] Wire Fast Harness services into live Heidi runtime (src/index.ts hooks: chat.message, experimental.chat.system.transform, tool.execute.before, event handler)
- [x] Per-user-task routing via heidi-route-state (manual user turns only; internal continuations never reclassify)
- [x] FAST_DIRECT lean live context (518 tokens vs 2933 baseline = 82.3% measured reduction)
- [x] Specialist turn-1 delegation contract injection
- [x] BACKEND domain + frontend/backend parallel specialist routing
- [x] ReadBatchService live consumption (prefetchRepositoryBatch for STANDARD/DEEP)
- [x] HeidiTaskState in live execution (compact <200-token packets)
- [x] RepositoryHotContext consumed in per-turn context; invalidated on HEAD/config/manifest change
- [x] ConfigCache-backed governance mode resolution on the hot path
- [x] GovernanceFastPath for read-only tools in tool.execute.before (<2ms p50 measured: 0.0001ms)
- [x] Token-accounting hot index (no full JSONL reread on hot queries)
- [x] Buffered non-critical audit persistence (bounded queue, size/periodic/dispose flush, critical immediate)
- [x] Deterministic tool-call repair wired before model inference
- [x] Performance telemetry wired into live hooks (<1ms p50 measured: 0.0017ms)
- [x] Canonical benchmark suite (10 task classes; real measurements recorded)
