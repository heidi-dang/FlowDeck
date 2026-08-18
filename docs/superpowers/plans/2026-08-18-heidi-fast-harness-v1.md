# Heidi Fast Harness v1 — Implementation Plan

**Branch:** `feat/heidi-fast-harness-v1`  
**Spec Reference:** `docs/superpowers/specs/2026-08-18-heidi-fast-harness-v1-design.md`  
**Date:** 2026-08-18  

---

## Milestone Execution Order

### Milestone A: Instrumentation & Baseline Measurement
- [ ] Task A1: Implement `HeidiPerformanceTracker` (`src/services/heidi-performance.ts`) for zero-overhead span/latency tracking.
- [ ] Task A2: Add unit tests (`tests/heidi-performance.test.ts`) testing timer accuracy, metrics calculations, CoT sanitization, and $<1\text{ ms}$ p50 overhead.
- [ ] Task A3: Create automated baseline runner (`tests/heidi-fast-harness-baseline.test.ts`) measuring the 10 canonical representative task types.

### Milestone B: Fast Router + FAST_DIRECT + Immediate Specialist Delegation
- [ ] Task B1: Implement `HeidiFastRouter` (`src/services/heidi-fast-router.ts`) with deterministic classification (`FAST_DIRECT`, `SPECIALIST`, `PARALLEL_SPECIALISTS`, `STANDARD`, `DEEP`, `SECURITY`, `UI`, `RELEASE`).
- [ ] Task B2: Add unit tests (`tests/heidi-fast-router.test.ts`) verifying instant Turn 1 routing for small fixes, failing test debugs, security audits, UI tasks, and parallel sub-tasks.
- [ ] Task B3: Wire fast router into Heidi task lifecycle.

### Milestone C: Prompt Reduction & Lazy Context / Specialist Loading
- [ ] Task C1: Refactor `src/agents/orchestrator.ts` to split permanent prompt ($< 900$ tokens) from lazy-loaded catalogs (specialists, workflow stages, domain workflows).
- [ ] Task C2: Implement dynamic prompt builder that excludes the specialist directory during `FAST_DIRECT` and injects targeted specialist routes on demand.
- [ ] Task C3: Add unit tests (`tests/heidi-prompt-reduction.test.ts`) verifying $\ge 60\%$ token reduction and dynamic route injection.

### Milestone D: Concurrent Repository Reads & Compact Tool Packets
- [ ] Task D1: Implement `ReadBatchService` (`src/services/read-batch.ts`) for parallel safe repository inspection (`fdx-read`, `fdx-grep`, `fdx-search`, `fdx-outline`).
- [ ] Task D2: Implement output summarizer/compactor for tool results before injection into model context.
- [ ] Task D3: Add unit tests (`tests/read-batch.test.ts`) verifying concurrent execution speedup and strict serialization of mutating operations.

### Milestone E: Externalized Task State & Repository Hot Context
- [ ] Task E1: Implement `HeidiTaskState` (`src/services/heidi-task-state.ts`) tracking compact semantic state outside conversation history.
- [ ] Task E2: Implement `RepositoryHotContext` (`src/services/repository-hot-context.ts`) caching root, HEAD SHA, branch, language, commands, layout, and FDX status with Git HEAD and manifest change invalidation.
- [ ] Task E3: Add unit tests (`tests/heidi-task-state.test.ts`, `tests/repository-hot-context.test.ts`).

### Milestone F: Configuration & Governance Fast-Path Caching
- [ ] Task F1: Implement `ConfigCache` (`src/services/config-cache.ts`) for zero-disk-read FlowDeck config, supervisor config, and agent models.
- [ ] Task F2: Implement `GovernanceFastPath` (`src/services/governance-fast-path.ts`) for $< 5\text{ ms}$ (target $< 2\text{ ms}$) read-only policy authorization.
- [ ] Task F3: Add unit tests (`tests/config-cache.test.ts`, `tests/governance-fast-path.test.ts`) proving full policy enforcement on writes and instant bypass for reads.

### Milestone G: Hot Path Persistence & Token Index Optimization
- [ ] Task G1: Update `TokenUsageStore` / `InMemoryTokenUsageStore` in `src/services/token-usage-store.ts` with in-memory lookup index.
- [ ] Task G2: Add unit tests (`tests/token-usage-hot-path.test.ts`) proving $O(1)$ query time and background durability.

### Milestone H: Deterministic Tool-Call Repair & Provider Cache Stabilization
- [ ] Task H1: Implement `ToolCallRepairService` (`src/services/tool-call-repair.ts`) for mechanical alias and argument normalization without model round-trips.
- [ ] Task H2: Ensure stable prefix structure in provider payloads to maximize provider-side KV caching.
- [ ] Task H3: Add unit tests (`tests/tool-call-repair.test.ts`).

### Milestone I: Comprehensive Benchmark, Regression & Verification Gates
- [ ] Task I1: Execute comparative benchmarks (isolated same-model & real-world mode).
- [ ] Task I2: Run full verification gates (lint, typecheck, build, test, coverage, doctor, doctor fix, FDX parity, pre-push full).
- [ ] Task I3: Merge into `main` and confirm green remote CI.
