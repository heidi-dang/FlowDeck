# FlowDeck v2 Autonomous Execution Intelligence

Milestone 1 adds a deterministic, advisory decision brain. It classifies an incoming task, scores complexity/ambiguity/risk with machine-readable evidence, analyzes bounded parallelism, selects a finite strategy, resolves canonical specialists, and recommends an existing token-budget profile.

## Historical routing audit

The historical `feat/orchestration-routing-intelligence` branch was audited against v2. Its taxonomy, evidence-backed scoring, finite strategy vocabulary, canonical-specialist concept, and policy-version gates are **PORT_WITH_CHANGES**. Its contracts and adversarial tests are source material, but were not cherry-picked because that branch removes current v2 persistence, token-budget, schema, Master Plan, and release work. Its model-selection authority and broad branch integration are **REJECT** for this milestone; model recommendations remain telemetry-only. Any branch content depending on pre-v2 runtime topology is **SUPERSEDED**.

## Canonical contracts

`src/orchestration/routing/contracts/task-intelligence.ts` is authoritative for the finite taxonomy, score bounds, evidence shape, parallelism levels, strategies, budget profiles, policy versions, canonical serialization, and finalized decision validation. Scores are integers from 0 through 100 and require evidence. Unknown classes are represented by the safe `unknown` fallback; arbitrary class strings are rejected.

`src/orchestration/routing/intelligence.ts` normalizes task text, paths, constraints, and repository signals before deterministic classification and scoring. Security-sensitive signals receive a risk floor. Identical normalized inputs produce identical decisions.

## Shadow mode

Configuration is `routing.enabled` plus `routing.mode`, where mode is `off` or `shadow`; the default is `off`. Shadow mode stores immutable `routing.decision.finalized` aggregates in the existing authoritative SQLite `events` store, exposes structured explanations at `GET /api/v1/orchestration/runs/:id/routing`, and compares the recommendation with the existing strategy. The legacy JSONL adapter is diagnostic/test-only and is not used by production composition or recovery. It does not select an agent, change a model, reserve tokens, change execution strategy, or affect completion.

Successful assessments emit bounded task-class, strategy, and delegation counters plus assessment duration. Divergence means only that the recommended strategy differs from the existing execution strategy; shadow failures are observable and non-blocking.

The current TokenBudgetController and canonical agent registry remain authoritative. The routing layer only recommends `small`, `normal`, `audit`, or `deep-audit`.

## Deferred work

Worktree-isolated scheduling, adaptive redistribution, performance learning, automatic model/provider switching, and authoritative routing enforcement are later milestones.
