# V2 Autonomous Execution Intelligence Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with test-first development and review checkpoints.

**Goal:** Add deterministic, evidence-backed task assessment and routing recommendations with immutable persistence and non-invasive shadow-mode production integration.

**Architecture:** Build a focused `src/orchestration/routing` domain that normalizes inputs, classifies against a finite taxonomy, scores complexity/ambiguity/risk, analyzes parallelism, selects finite strategies and canonical specialists, and recommends existing token profiles. Persist finalized decisions through the current orchestration event/persistence boundary, expose structured explanations and bounded metrics, and invoke the engine from production only in `off`/ `shadow` mode.

**Tech Stack:** TypeScript, Zod, Bun tests, current SQLite/event-store repositories, existing agent registry, TokenBudgetController, orchestration metrics/API.

## Global Constraints

- Base branch is `v2.0.0-alpha` at `0ac894959587e5a2dfc11a66766fc834a64d5226`.
- Work only on `feat/v2-autonomous-execution-intelligence`; do not modify `main` or v2 directly.
- Historical routing branch is source material only; do not cherry-pick it wholesale.
- Routing is deterministic, finite, versioned, evidence-backed, and fail-closed.
- Scores are integers in 0–100; every non-trivial score has unique machine-readable evidence.
- Shadow mode must not change current execution strategy, agent, model, budget, or completion behavior.
- Existing TokenBudgetController remains authoritative; routing only recommends profiles.
- No worktree scheduler, adaptive redistribution, learning system, or automatic model switching.

### Task 1: Audit and contract inventory

**Files:**
- Create: `docs/architecture/v2-autonomous-execution-intelligence.md`
- Test: `tests/routing/audit-contract.test.ts`

- [ ] Record historical routing reuse matrix and current v2 integration points.
- [ ] Document exact taxonomy, score/policy versions, shadow modes, and rejected legacy concepts.
- [ ] Test that canonical registry and token-budget profiles are the current sources of truth.

### Task 2: Canonical assessment contract

**Files:**
- Create: `src/orchestration/routing/contracts/task-intelligence.ts`
- Create: `src/orchestration/routing/contracts/policy.ts`
- Test: `tests/routing/task-intelligence-contract.test.ts`

- [ ] Write failing tests for finite task classes, bounded scores, parallelism enum, unique evidence, immutable policy objects, and required IDs/versions.
- [ ] Implement Zod/type contracts for assessment input/output, evidence, workstreams, policy versions, and budget profiles.
- [ ] Add canonical serialization/hash helpers using existing deterministic utilities.

### Task 3: Deterministic classification and scoring

**Files:**
- Create: `src/orchestration/routing/intelligence/normalize.ts`
- Create: `src/orchestration/routing/intelligence/classifier.ts`
- Create: `src/orchestration/routing/intelligence/scorers.ts`
- Test: `tests/routing/intelligence.test.ts`

- [ ] Add classification corpus for all supported classes.
- [ ] Implement normalized text/path/evidence ordering.
- [ ] Implement deterministic complexity and ambiguity scores with separate signals.
- [ ] Implement risk floors for security, auth, secrets, migrations, release, deletion, deployment, payments, and concurrency.
- [ ] Ensure identical normalized inputs produce byte-identical results.

### Task 4: Parallelism and strategy planning

**Files:**
- Create: `src/orchestration/routing/planning/parallelism.ts`
- Create: `src/orchestration/routing/planning/strategy.ts`
- Create: `src/orchestration/routing/planning/delegation.ts`
- Test: `tests/routing/planning.test.ts`

- [ ] Implement deterministic workstream ordering, ownership overlap checks, dependency validation, and cycle rejection.
- [ ] Implement finite strategy selection with rationale and rejected alternatives.
- [ ] Resolve requested capabilities through the canonical agent registry and reject primary/depth-invalid/duplicate ownership assignments.
- [ ] Recommend existing `small`, `normal`, `audit`, and `deep-audit` profiles without reserving or resetting budget.

### Task 5: Routing decision and persistence

**Files:**
- Create: `src/orchestration/routing/decision.ts`
- Modify: current orchestration persistence/event files only after inventory
- Test: `tests/routing/persistence.test.ts`

- [ ] Define immutable decision containing assessment, strategy, delegation, parallelism, budget recommendation, source SHA, run/contract bindings, policy versions, and timestamps.
- [ ] Persist through the current authoritative runtime boundary; avoid direct schema edits unless a versioned migration is required.
- [ ] Add restart reconstruction, finalized immutability, new-version reassessment, cross-run isolation, and stale SHA detection.

### Task 6: Shadow-mode integration, metrics, and API explanation

**Files:**
- Modify: existing routing configuration schema/types
- Modify: current plugin/runtime composition and orchestration metrics
- Modify: existing API/projection layer
- Test: `tests/routing/shadow-integration.test.ts`, `tests/routing/metrics-api.test.ts`

- [ ] Add finite `off`/`shadow` configuration with default preserving behavior.
- [ ] Invoke assessment beside the current production decision path and persist comparison telemetry.
- [ ] Prove strategy, delegation, model, budget, and completion outputs are unchanged.
- [ ] Add low-cardinality routing metrics and structured explanation projection.

### Task 7: Adversarial gates and documentation

**Files:**
- Modify: `scripts/pre-push.mjs` or validation scripts only where needed
- Create/modify: routing docs and tests
- Test: complete `tests/routing` suite

- [ ] Add policy-version/fingerprint protection and adversarial determinism tests.
- [ ] Run Master Plan, schema, token/context, orchestration, full, package, and pre-push gates.
- [ ] Review staged diff and commit coherent milestone changes.
- [ ] Push feature branch and create a draft PR targeting `v2.0.0-alpha`.
