# FlowDeck Routing and Model Selection — Architecture

**Author:** Dev 4 (Routing, Scheduling, Models, Capabilities)
**Status:** Target architecture — partially implemented (PR 1: contracts, classifier, scoring); remainder is planned stacked work
**Baseline SHA:** `5809fcf` (v1.0.3)
**Scope:** This document describes the canonical routing and model-selection architecture for the FlowDeck orchestration system.

> **Subordination notice:** This document is subordinate to the Dev 2 master plan. It does NOT propose
> replacing Dev 2's runtime state machine, task contracts, completion engine, context store, or telemetry
> persistence. Dev 4 adds a deterministic decision layer (routing, scheduling, models, capabilities) **on top
> of** Dev 2's interfaces. Where a Dev 4 feature would need to change Dev 2-owned behavior, the change is
> flagged as a dependency and routed to Dev 2, never implemented unilaterally.

> **Implementation status legend.** Every section below is tagged with one of two statuses:
>
> - **Implemented (PR 1)** — code exists in the stacked PR 1 work (contracts, classifier, scoring).
>   These artifacts are NOT yet merged into the baseline and are NOT active in the harness at `5809fcf`.
> - **Planned** — design agreed in this document; implementation is scheduled as stacked work after PR 1.

---

## 1. Current Routing Architecture (Baseline `5809fcf`, v1.0.3)

What exists today at the baseline. Dev 4 must be compatible with all of this.

### 1.1 Legacy execution policy — `src/services/heidi-execution-policy.ts`

The current harness selects an execution strategy from a prompt-level list defined in this file. The legacy
`ExecutionStrategy` union has **8 values**:

```
fast_direct, direct, explore_then_direct, planner_then_execute,
debugger_root_cause, frontend_backend_parallel, audit_only, audit_after_change
```

The file also provides:

- `evaluateDelegationJustification(ctx)` — returns `{ justified, reasons[] }` from a `DelegationContext`
  with flags: `explicitUserRequest`, `independentOwnership`, `specialistDomainRequired`,
  `auditOrSecurityReview`, `directDiscoveryFailed`, `multiDomainSpanning`. Delegation is permitted ONLY when
  at least one justification flag is true.
- `performSurfaceAreaCheck(...)` — pre-edit inspection of dependents, existing tests, related config,
  assumptions, and error paths.
- `BoundedRecoveryTracker` — 3-step bounded recovery: `targeted_diagnosis` → `change_hypothesis` →
  `circuit_breaker_block`.

**Dev 4 stance:** this file remains untouched. It is the *current* harness. The canonical strategy list in
section 6 supersedes the legacy prompt-level list as the routing-layer vocabulary, but the legacy file is not
modified by Dev 4.

### 1.2 Telemetry-only model guidance — `src/services/model-router.ts`

- `classifyTaskComplexity(task)` returns `RoutingDecision { complexity, reason, eligible_agents }` where
  `TaskComplexity = "cheap" | "standard" | "expensive"`.
- `AgentTier = "cheap" | "standard" | "expensive"` with an `AGENT_TIER_MAP` per agent.
- `filterAgentsForStage(stage)` and `computePromptSlimmingStats(allAgents)` drive stage-aware prompt slimming.
- `getOutputFormatHint(complexity)` returns a compact-JSON hint for cheap tasks.

The file header is explicit: **"This service is telemetry/guidance only. It does NOT change which model
OpenCode uses for each call."** Actual model switching is explicitly marked as a TODO and does not exist.

### 1.3 Centralized agent registry — `src/services/canonical-registry.ts`

Single source of truth for all agent configuration. **13 agents** are registered:

```
heidi (alias: orchestrator), planner, architect, researcher, mapper,
backend-coder, frontend-coder, devops, tester, reviewer, security-auditor, debug-specialist
```

Key defaults relevant to routing:

- `modelPolicy: "inherit"` for every agent (no per-agent model pinning).
- `maxDelegationDepth: 1` — exactly one level of delegation.
- `delegationPolicy`: `"justified_only"` for `heidi`/`orchestrator`; `"none"` for all specialists.
- Only heidi/orchestrator may delegate (`canAgentDelegate`); specialists never delegate.
- `validateDelegation(delegatingAgent, currentDepth)` blocks depth >= 1 and non-delegating agents.

### 1.4 Enforcement — `src/index.ts` (`tool.execute.before`)

The runtime enforces governance at tool-call time:

- `validateDelegationDepth` gate on every `task` tool call; `SELF_DELEGATION_BLOCKED` returned when an agent
  targets itself; `MISSING_TARGET_AGENT` for unknown targets.
- Child-session correlation via deterministic FIFO pending-slot queue per `(parentSessionID, targetAgent)`.
- Delegation budgets with defaults: `maxToolCalls = 200`, `maxSameStepRetries = 3`, `maxDelegations = 20`
  (configurable under `flowdeckConfig.governance.delegationBudget`).

### 1.5 Supervisor pipeline — `src/services/supervisor-binding.ts`

Every task follows the single pipeline `FD_PIPELINE`:

```
FD_PIPELINE = [fd-task, fd-review, fd-execute, fd-verify, fd-done]
```

No workflow classes, no alternative paths. The only sanctioned deviation is the trivial-task shortcut, which
may skip `fd-review` and `fd-verify` (`TRIVIAL_SKIPPABLE_STAGES`) provided the reason is logged.

### 1.6 Dev 2 / Dev 3 orchestration runtime — `src/orchestration/`

An event-sourced orchestration runtime already exists and is owned by Dev 2/3:

```
src/orchestration/
├── api/            (public API surface)
├── streaming/      (event streaming)
├── contracts/      (contract domain, hashing, services, policies, ports, adapters)
├── domain/         (domain model)
├── persistence/    (repositories incl. sqlite outbox adapter)
├── services/       (orchestration services)
├── projections/    (projections)
├── completion/     (completion engine)
├── evidence/       (evidence records)
├── idempotency/    (idempotency keys)
├── approval/       (approval flows)
├── override/       (user override)
├── verification/   (verification engine)
└── index.ts        (barrel)
```

Dev 4 consumes the stable interfaces exposed by this runtime (events, persistence ports, completion,
verification) and emits routing decisions as domain events through shared contracts. Dev 4 does not modify
these sub-domains.

---

## 2. Prompt-Driven Weaknesses

The baseline makes all routing decisions through prompt prose. This section catalogues the concrete failures
that motivate the deterministic decision layer.

| # | Weakness | Description |
|---|---|---|
| 1 | Classification is prose | Task complexity is decided by an LLM reading instructions about "cheap vs expensive"; no deterministic classifier, no stable output. |
| 2 | Scoring is absent | There are no complexity/ambiguity/risk/confidence scores. Nothing is measured on a scale, so nothing can be compared across runs. |
| 3 | Strategy selection is manual | The orchestrator prompt lists strategies; the model picks one ad hoc. No rule maps task properties to a strategy, and no rejected-strategy record exists. |
| 4 | No runtime measurement | No signals (file count, domain count, test surface, dependency depth) are collected at decision time. Decisions cannot be audited or tuned. |
| 5 | No reproducibility | Two identical prompts can route differently across runs because nothing is deterministic. Repeated-run equivalence cannot be guaranteed or measured. |
| 6 | No provenance | No record of why a strategy, delegation, or agent was chosen. Post-hoc review and rollback analysis are impossible. |
| 7 | Model router cannot switch models | `src/services/model-router.ts` is telemetry-only by design. It reports a tier but never changes which model executes a call. |
| 8 | Delegation justification is advisory | `evaluateDelegationJustification` returns reasons, but nothing enforces a budget table, overlap checks, or rejection reasons. |
| 9 | No capability awareness | Agents are routed by name and prose description, never by a machine-readable capability contract, so any agent may be asked for work it cannot perform. |

**Consequence:** routing behavior is emergent and unverifiable. The target architecture replaces the prose
path with a deterministic decision layer while keeping the current harness operational during rollout.

---

## 3. Target Architecture

Dev 4 introduces a deterministic decision layer under `src/orchestration/routing/`. It consumes Dev 2 runtime
interfaces and Dev 3 capability metadata, and emits routing events through shared contracts.

**Status: contracts, classifier, scoring implemented in PR 1 (not active at baseline). Strategy, capabilities,
delegation, scheduling, models, and providers are planned.**

```
                          ┌──────────────────────────────────────────┐
                          │               user request                │
                          └───────────────────┬──────────────────────┘
                                              │
                                              v
        ┌─────────────────────────────────────────────────────────────────┐
        │                src/orchestration/routing/                       │  Dev 4
        │                                                                 │
        │  contracts/   ── RoutingDecisionRecord, StrategyPolicy,         │  (PR 1: contracts,
        │                 DelegationDecision, ModelRoutingInput,          │   classifier, scoring
        │                 ModelSelectionDecision, CapabilityDescriptor    │   implemented;
        │                                                                 │   rest planned)
        │  classifier/  ── TaskClass taxonomy (17 classes, 16 inputs)     │
        │                 deterministic, rule-first, LLM fallback         │
        │                                                                 │
        │  scoring/     ── complexity / ambiguity / risk / confidence     │
        │                 (0-100, evidence-referenced)                    │
        │                                                                 │
        │  strategy/    ── canonical ExecutionStrategy + StrategyPolicy   │  (planned)
        │  capabilities/── capability registry, derives from              │  (planned)
        │                 canonical-registry.ts                           │
        │  delegation/  ── DelegationDecision, budgets, rejection         │  (planned)
        │  scheduling/  ── bounded parallelism, ownership leases          │  (planned)
        │  models/      ── model tier selection, provider-neutral         │  (planned)
        │  providers/   ── provider resilience, circuit breaker           │  (planned)
        └──────────┬───────────────────────────────────────────────┬─────┘
                   │                                              │
                   │ consumes                                     │ emits
                   v                                              v
   ┌────────────────────────────────────┐          ┌─────────────────────────────┐
   │  Dev 2 runtime interfaces          │          │  shared contracts / events  │
   │  (src/orchestration/: events,      │          │  (routing decisions,         │
   │   persistence, completion,         │          │   rejections, escalations,   │
   │   verification, evidence)          │          │   shadow comparisons)        │
   └────────────────────────────────────┘          └─────────────────────────────┘
                   │
                   v
   ┌────────────────────────────────────┐
   │  Dev 3 capability metadata         │
   │  (FDX capability descriptors,      │
   │   index inspection, tools)         │
   └────────────────────────────────────┘
```

**Layering rules**

1. `routing/` calls Dev 2 interfaces; Dev 2 never imports `routing/`.
2. `routing/` reads Dev 3 capability metadata; it does not own FDX.
3. All decision output is written as domain events through the existing event infrastructure; no separate
   decision store is introduced (section 13).
4. The legacy harness (`heidi-execution-policy.ts`, `model-router.ts`) remains the active path until shadow
   mode (section 14) and rollout (section 16) complete.

---

## 4. Task Taxonomy

**Status: classifier implemented in PR 1.**

### 4.1 TaskClass — 17 values

| TaskClass | Meaning | Example |
|---|---|---|
| `trivial_edit` | Single-file, no logic change | typo, rename, config value |
| `documentation` | Docs-only change | README, ADR, comments |
| `read_only_question` | Answer a question, no mutation | "how does X work?" |
| `repository_audit` | Systematic read-only review of the repo | dependency audit, convention audit |
| `local_bug` | Bug contained to a module | failing unit test, wrong branch |
| `cross_module_feature` | Feature spanning 3+ files/modules | new service + API + persistence |
| `ci_failure` | CI pipeline failure | lint/test/build job red |
| `build_package_failure` | Local build or package failure | tsc error, bundler failure |
| `release_failure` | Release pipeline failure | version bump, publish, tag |
| `database_migration` | Schema or data migration | new table, column rename |
| `concurrency_failure` | Race, deadlock, parallel-safety bug | overlapping writes, async race |
| `security_review` | Security audit or fix | auth bypass, injection |
| `performance_work` | Performance investigation/optimization | N+1 query, slow render |
| `ui_feature` | Frontend/UI implementation | component, styling, screen |
| `production_incident` | Live production outage or degradation | prod error, incident response |
| `recovery_resume` | Resume or recover an interrupted task | state-machine recovery, re-run |
| `unknown` | Classifier cannot determine a class | fallback class |

### 4.2 Classification inputs — the signal set

The classifier consumes the following input dimensions (derived from the user prompt plus runtime
measurement at decision time):

```
read-only/mutating        file count               domain count          test surface
repository criticality    production impact        release impact        security sensitivity
migration                 concurrency              UI                    CI context
explicit audit request    ambiguity                independent review need
user-required specialist  recovery state
```

**Classification rules**

- Deterministic, rule-first: class is decided by matching inputs against the taxonomy tables before any LLM
  fallback is consulted.
- The LLM fallback is used only when the deterministic path yields `unknown`, and the fallback result is
  recorded with `confidence` (section 5) and provenance (section 13).
- Inputs are normalized (case, whitespace, synonyms) before matching.

---

## 5. Scoring Model

**Status: scoring implemented in PR 1.**

Four independent scores, each on a **0–100** integer range, are computed for every task at decision time.

| Score | Meaning | Direction |
|---|---|---|
| `complexity` | Structural size and interconnectedness | higher = more complex |
| `ambiguity` | How underspecified or contradictory the task is | higher = more ambiguous |
| `risk` | Worst-case consequence of executing the task | higher = more dangerous |
| `confidence` | Classifier/scorer certainty in its own output | higher = more certain |

### 5.1 Complexity signals

- file count
- domain count
- dependency depth
- checks (test/verification surface)
- workstreams (parallel streams implied)
- migration
- concurrency
- cross-platform
- external integration

### 5.2 Risk signals

- production/release effect
- data integrity
- security
- destructive operations
- migration
- concurrency
- auth
- package publication
- infrastructure
- rollback difficulty
- uncertain external side effects

### 5.3 Ambiguity signals

- missing target (no clear object of the change)
- unclear success criteria
- conflicting requirements
- unknown repository
- incomplete reproduction
- missing error evidence
- undefined ownership (no file/domain owner identified)

### 5.4 Evidence references

Every score carries an `evidence` list. Each evidence entry is a `{ signal, value, source }` triple where
`source` is a stable reference (file path, tool output pointer, prompt fragment index). A score with no
evidence is treated as a defect (see metric `decisions without evidence = 0`, section 15).

### 5.5 High-risk minimum rules

Any task satisfying **any** of the following gets a `risk >= 70` floor and triggers the high-risk capability
floor (sections 10, 12) plus mandatory review:

- touches production data or a live production system
- touches authentication or authorization
- performs destructive operations (delete, force-push, drop, purge)
- is a database migration
- publishes a package or mutates a registry
- involves concurrent writers to the same ownership domain
- is a security review or security fix
- has uncertain external side effects with no rollback path

For high-risk tasks: verification level is at least `full` (section 6), required reviewers are non-empty,
`approvalRequirements` apply, and the model tier may never be silently downgraded below the capability floor
(section 12).

---

## 6. Strategy Contracts

**Status: planned.**

### 6.1 Canonical ExecutionStrategy — 9 values

The routing layer uses the following canonical strategy vocabulary:

```
fast_direct                direct_verified            explore_then_execute
planned_execution          parallel_implementation    root_cause_repair
audit_only                 repair_and_independent_audit   recovery_resume
```

| Strategy | Purpose | Typical TaskClass |
|---|---|---|
| `fast_direct` | Single-shot direct edit, minimal ceremony | `trivial_edit`, `documentation` |
| `direct_verified` | Direct edit followed by verification | `local_bug`, `ui_feature` |
| `explore_then_execute` | Map/repo discovery before mutation | `cross_module_feature`, `repository_audit` |
| `planned_execution` | Plan first, then execute steps | `cross_module_feature`, `database_migration` |
| `parallel_implementation` | Independent workstreams run concurrently | `cross_module_feature` (independent domains) |
| `root_cause_repair` | Reproduce, diagnose, fix root cause | `local_bug`, `concurrency_failure`, `ci_failure` |
| `audit_only` | Read-only analysis, no mutation | `security_review`, `repository_audit` |
| `repair_and_independent_audit` | Fix, then independent verification by a separate reviewer | `security_review`, `production_incident` |
| `recovery_resume` | Resume/recover an interrupted run | `recovery_resume` |

### 6.2 StrategyPolicy

Each strategy carries a policy record:

```typescript
interface StrategyPolicy {
  strategy: ExecutionStrategy;
  allowedStates: string[];              // Dev 2 state-machine states where this strategy is valid
  maximumSpecialists: number;           // cap on concurrent specialist sessions
  requiredCapabilities: Capability[];   // capabilities that must exist before strategy starts
  requiredReviewers: string[];          // reviewer agents required for this strategy
  verificationLevel: "focused" | "standard" | "full" | "release";
  contextBudget: number;                // relative budget weight for context/token use
  modelTier: ModelTier;                 // baseline model tier (section 10)
  recoveryLimit: number;                // max repair cycles (Dev 2 recovery interface)
  approvalRequirements: string[];       // human approvals required, if any
}
```

### 6.3 Mapping note — legacy vs canonical

The canonical list **supersedes the legacy prompt-level strategy list** as the routing-layer vocabulary.

| Legacy (`heidi-execution-policy.ts`) | Canonical (routing layer) | Relationship |
|---|---|---|
| `fast_direct` | `fast_direct` | kept identical |
| `direct` | `direct_verified` | superseded: canonical requires verification |
| `explore_then_direct` | `explore_then_execute` | superseded: canonical has explicit policy |
| `planner_then_execute` | `planned_execution` | superseded |
| `debugger_root_cause` | `root_cause_repair` | superseded |
| `frontend_backend_parallel` | `parallel_implementation` | generalized superseded |
| `audit_only` | `audit_only` | kept identical |
| `audit_after_change` | `repair_and_independent_audit` | superseded: canonical requires independent auditor |
| — | `recovery_resume` | new: formalizes recovery as a strategy |

**The legacy `src/services/heidi-execution-policy.ts` remains untouched and remains the current harness.**
The canonical list is the target vocabulary the deterministic layer selects from; until rollout completes, the
legacy path continues to operate. No legacy file is modified by Dev 4.

---

## 7. Capability Registry

**Status: planned.**

### 7.1 CapabilityDescriptor

```typescript
interface CapabilityDescriptor {
  capability: string;                     // canonical capability id
  allowedAgents: string[];                // agents that may perform this capability
  tools: string[];                        // tool ids required for the capability
  mutating: boolean;                      // true if capability modifies state
  requiresHuman: boolean;                 // human approval gate required
  supportsParallelism: boolean;           // may run concurrently with other work
  supportsCancellation: boolean;          // work can be cancelled mid-flight
  expectedLatencyClass: "fast" | "medium" | "slow"; // latency budget hint
}
```

### 7.2 Example capabilities

| Capability | mutating | requiresHuman | supportsParallelism | supportsCancellation | expectedLatencyClass |
|---|---|---|---|---|---|
| `repository inspection` | false | false | true | true | fast |
| `code mutation` | true | false | false | false | medium |
| `GitHub inspection` | false | false | true | true | medium |
| `CI log inspection` | false | false | true | true | medium |
| `release operation` | true | true | false | false | slow |
| `database migration` | true | true | false | false | slow |
| `security audit` | false | false | true | true | slow |
| `UI implementation` | true | false | false | false | medium |
| `FDX index inspection` | false | false | true | true | fast |
| `package publication` | true | true | false | false | slow |
| `destructive Git` | true | true | false | false | medium |
| `infrastructure change` | true | true | false | false | slow |

### 7.3 Registry derivation

The capability registry **derives from `src/services/canonical-registry.ts`**: the canonical registry remains
the single source of truth for agent identity, tools, and ownership; capabilities are a projection of that
data (agent id → allowedTools → capability descriptors) plus explicit capability declarations. No conflicting
agent list is maintained. `requiredCapabilities` in a `StrategyPolicy` is validated against this derived
registry before a strategy starts.

---

## 8. Delegation Rules

**Status: planned.**

### 8.1 DelegationDecision

```typescript
interface DelegationDecision {
  taskId: string;
  delegatingAgent: string;
  targetAgent: string;
  depth: number;                          // must be exactly 0 or 1
  allowed: boolean;
  reason?: "explicit_user_request" | "independent_ownership" | "specialist_expertise"
        | "independent_audit" | "direct_discovery_failed" | "multi_domain";
  rejectionReason?: "rejected_trivial" | "rejected_overlap" | "rejected_no_advantage"
        | "rejected_cost";
  justification: string[];                // persisted evidence for the decision
}
```

### 8.2 Allowed delegation reasons

| Reason | Meaning |
|---|---|
| `explicit_user_request` | User named or requested a specialist |
| `independent_ownership` | Work has non-overlapping file ownership |
| `specialist_expertise` | Requires domain expertise the primary lacks |
| `independent_audit` | Independent verification/review required |
| `direct_discovery_failed` | Direct repository discovery failed |
| `multi_domain` | Change spans multiple technical domains |

### 8.3 Rejection reasons

| Reason | Meaning |
|---|---|
| `rejected_trivial` | Task too small to justify a session |
| `rejected_overlap` | Delegation overlaps existing work/writes |
| `rejected_no_advantage` | Specialist offers no measurable benefit |
| `rejected_cost` | Cost/duration exceeds benefit |

### 8.4 Hard constraints

- **Max depth is exactly 1.** `validateDelegation` in the canonical registry already enforces this; the
  routing layer never produces a `depth > 1` decision.
- **No self-delegation.** Any decision targeting the delegating agent is rejected (`SELF_DELEGATION_BLOCKED`
  semantics preserved).
- **No specialist delegation.** Specialists (`delegationPolicy: "none"` in canonical-registry.ts) never
  delegate; the routing layer never emits a decision with a specialist as `delegatingAgent`.

### 8.5 Budget table

Delegation budgets are enforced per task class. Exceeding a budget requires a persisted justification (written
to the decision record, section 13).

| Task class (group) | Max specialist sessions |
|---|---|
| typo / config | 0 |
| documentation | 0–1 |
| local bug | 0–2 |
| cross-module feature | 2–4 |
| CI / release | 3–6 |
| architecture migration | 5–10 |
| production incident | independent-domains-only (no overlapping writes) |

---

## 9. Specialist Budgets and Scheduling Rules

**Status: planned.**

Scheduling is implemented through the Dev 2 runtime interfaces; Dev 4 supplies the decision inputs.

| Rule | Description |
|---|---|
| Bounded parallelism | Concurrent specialist sessions never exceed `StrategyPolicy.maximumSpecialists` for the active strategy. |
| Ownership leases | Specialists acquire ownership leases through the Dev 2 interface for their file/domain scope; no second writer obtains the same lease. |
| Serialize overlapping writes | Two workstreams whose leases overlap are serialized, never run concurrently. |
| Verification capacity reservation | `requiredReviewers` sessions reserve verification capacity before execution starts; verification is never starved by execution work. |
| Obsolete-work cancellation | When a decision supersedes in-flight work (e.g., a new hypothesis after a failed attempt), obsolete sessions are cancelled via `supportsCancellation` capabilities. |
| Deterministic terminal outcomes | Every scheduled session reaches a terminal state (completed, rejected, cancelled) recorded in the decision record; no session is left indeterminate. |

---

## 10. Model Tiers

**Status: planned.**

### 10.1 ModelTier — provider-neutral

```
small_fast        |   general_coding        |   strong_reasoning
```

Tiers are **provider-neutral**. The document and the code contain **no hardcoded provider or model id**.
Tier selection produces a requirement; provider resolution (which provider/model actually serves a tier) is
the job of the provider layer (section 12) at call time.

### 10.2 Per-tier use lists

| Tier | Use for |
|---|---|
| `small_fast` | classification fallback, log summarization, result extraction, context compaction, simple docs, progress summary, low-risk routing |
| `general_coding` | standard implementation, repo reasoning, test authoring, common bug repair |
| `strong_reasoning` | complex root cause, architecture, concurrency, migration, high-risk security, ambiguous multi-system incidents, critical independent audit |

### 10.3 Interfaces

```typescript
interface ModelRoutingInput {
  taskId: string;
  taskClass: TaskClass;
  scores: { complexity: number; ambiguity: number; risk: number; confidence: number };
  capabilityFloor: Capability[];          // capabilities the model must be able to perform
  strategy: ExecutionStrategy;
  timeoutPolicy: { queueMs: number; firstTokenMs: number; totalMs: number };
  providerHealth?: Record<string, number>; // provider health scores (section 12)
}

interface ModelSelectionDecision {
  tier: ModelTier;
  provider?: string;                      // optional; resolved at call time, never pinned here
  model?: string;                         // optional; resolved at call time, never pinned here
  confidence: number;                     // 0-100
  reasonCodes: string[];                  // deterministic codes, e.g. "HIGH_RISK_FLOOR"
  fallbackTiers: ModelTier[];             // ordered fallback list
  timeoutPolicy: { queueMs: number; firstTokenMs: number; totalMs: number };
  capabilityFloor: Capability[];          // the floor this selection was required to satisfy
}
```

**Capability floor:** a selection must satisfy `capabilityFloor`. If the cheapest tier cannot satisfy it, the
selection moves up tiers until the floor is met (section 12: never silently downgrade below the floor).

---

## 11. Escalation Policy

**Status: planned.**

The system starts at the **cheapest tier with sufficient capability** and escalates only on objective signals.

**Escalate when:**

1. Classification confidence is below the confidence floor (`confidence < 60`, see section 5).
2. Ambiguity persists after the evidence-gathering pass (`ambiguity >= 70`).
3. The first hypothesis fails with evidence (first failure on a `root_cause_repair`/`planned_execution` path).
4. Critical evidence is missing (no reproduction, no error output, unknown repo).
5. A high-risk state is entered (section 5.5 triggers).
6. Historical success for the agent/task class is below the success threshold.
7. A capability-floor violation is detected (selected tier cannot perform `requiredCapabilities`).

**Never:**

- Escalate because output is long (length is not a complexity signal).
- Escalate/downgrade loops: each task has a single escalation path; a downgrade only follows an explicit
  evidence-backed decision, and the pair is recorded (section 13) to prevent oscillation.

Escalation always records `reasonCodes` and the scores that triggered it.

---

## 12. Provider Resilience

**Status: planned.**

The provider layer resolves a tier to an actual provider/model at call time and handles failures. It is
provider-neutral in the same sense as section 10.

| Mechanism | Behavior |
|---|---|
| Queue timeout | Wait-for-slot timeout; on expiry, try next candidate provider. |
| First-token timeout | Timeout from request start to first token; on expiry, fail over. |
| Total-response timeout | Hard cap on the whole response; on expiry, cancel and record. |
| Provider health score | Rolling score per provider (0-100) updated after every call. |
| Recent failure window | Failures within the window weigh heavily in the health score. |
| Circuit breaker | Provider opens after repeated failures; open providers are not called. |
| Cooldown | Opened providers enter cooldown before being probed again. |
| Fallback list | Ordered provider candidates per tier from `ModelSelectionDecision.fallbackTiers`. |
| Cancellation | In-flight calls are cancelled on failover via `supportsCancellation`. |
| Retry policy | Retries occur ONLY when the call is non-mutating, or idempotent, or reconciliation confirms the operation is safe to repeat. Never retry blindly after a mutation. |
| Idempotency awareness | Idempotency keys from the Dev 2 idempotency sub-domain gate retries of mutating calls. |
| High-risk capability floor | For high-risk tasks (section 5.5), the tier may escalate but never silently downgrade below `capabilityFloor`; a downgrade attempt is a defect (metric `high-risk downgrades = 0`, section 15). |

Every failover and retry decision is appended to the decision record with provider names, health scores, and
reason codes (section 13).

---

## 13. Decision Provenance

**Status: planned.**

Every production routing decision is persisted as a `RoutingDecisionRecord` through the existing event
infrastructure. No separate decision store is introduced.

```typescript
interface RoutingDecisionRecord {
  taskId: string;
  timestamp: string;                      // ISO-8601
  repositorySha: string;                  // exact SHA the decision was made against
  routingPolicyVersion: string;           // version of the routing policy tables used

  inputEvidence: Array<{ signal: string; value: unknown; source: string }>;
  rulesApplied: string[];                 // deterministic rule ids that fired
  modelFallbackUsed: boolean;             // true if an LLM fallback was consulted

  scores: { complexity: number; ambiguity: number; risk: number; confidence: number };

  taskClass: TaskClass;
  selectedStrategy: ExecutionStrategy;
  rejectedStrategies: Array<{ strategy: ExecutionStrategy; reason: string }>;

  specialistCandidates: string[];
  delegationDecisions: DelegationDecision[];

  modelCandidates: Array<{ tier: ModelTier; provider?: string; reason: string }>;
  selectedTier: ModelTier;
  fallback: ModelTier[];

  confidence: number;
  outcome?: "pending" | "success" | "failed" | "superseded" | "cancelled";
}
```

**Guarantees**

- Every production routing decision produces exactly one record (`recorded decisions = 100%`, section 15).
- Records are immutable after write; corrections are new records referencing the original.
- The record is the single source of truth for post-hoc review, shadow comparison (section 14), and rollback
  analysis (section 16).

---

## 14. Shadow Mode

**Status: planned.**

Shadow mode is the rollout gate between the legacy prompt-driven path and the deterministic path.

**Execution model**

- The **current (legacy) routing executes** — user-visible behavior is unchanged.
- The **candidate (deterministic) routing observes** — it computes classifications, scores, strategies,
  specialists, and model selections in parallel.
- **No mutation** — the candidate never delegates, never calls providers, never changes files or sessions.
- Only the decision computation runs; all candidate output goes to shadow comparison.

**Comparison dimensions**

```
strategy                 specialist count         selected specialists
expected cost            expected duration        actual outcome
verification completeness  recovery               task success
unnecessary work
```

**Activation rule:** a candidate routing is promoted only after statistically significant agreement with the
legacy path across many runs. **Never activate from a single session.** Promotion requires at least the
thresholds in section 15's metrics (repeated-run equivalence, recorded decisions, etc.) plus a Dev 4 report
(section 18) reviewed before the flag flips.

---

## 15. Evaluation Corpus and Performance Budgets

**Status: corpus planned; classifier/scoring unit tests part of PR 1.**

### 15.1 Evaluation corpus

A deterministic fixture corpus is maintained for classification and scoring:

- Each fixture is `{ input, expectedTaskClass, expectedScores, expectedStrategy, expectedDelegation }`.
- Fixtures are versioned with the routing policy version and checked in under `tests/routing/` (fixtures) with
  benchmarks under `scripts/` (routing benchmarks).
- The corpus is deterministic: same input, same expected output, run on any machine.

### 15.2 Target metrics

| Metric | Target |
|---|---|
| Deterministic classification | 100% of corpus fixtures classified by rules (LLM fallback never required for fixtures) |
| Recorded decisions | 100% of production routing decisions persisted |
| Recursive delegation | 0 |
| Self-delegation | 0 |
| Overlapping writes | 0 |
| Specialist sessions | -30% vs baseline |
| Redundant investigations | -40% vs baseline |
| Model cost | -35% vs baseline |
| Repeated-run equivalence | >= 90% (same input → same decision) |
| High-risk downgrades | 0 |
| Unbounded retries | 0 |
| Missing terminal results | 0 |
| Decisions without evidence | 0 |

Metrics are measured per campaign via the Dev 4 report (section 18) and the persisted decision records.

---

## 16. Fault Handling, Rollout, and Rollback

**Status: planned.**

### 16.1 Activation

- All routing features are gated behind configuration flags (disabled by default at baseline).
- Flag categories: `routing.classifier`, `routing.scoring`, `routing.strategy`, `routing.delegation`,
  `routing.scheduling`, `routing.models`, `routing.providers`, `routing.shadow`.

### 16.2 Rollout order

1. **Shadow first.** Enable `routing.shadow` with the candidate observing, never acting (section 14).
2. Classifier and scoring in shadow: verify deterministic classification and score stability on live input.
3. Strategy/delegation selection in shadow: verify agreement with legacy behavior and the budget table.
4. Scheduling and models in shadow: verify parallelism caps and provider selection without mutating anything.
5. Providers in shadow: verify failover and timeouts against health scores.
6. Only after shadow metrics pass (section 15) is any flag flipped to active.

### 16.3 Fault handling

- Any candidate failure in shadow is a shadow-only incident; the legacy path is unaffected.
- In active mode, a routing fault (missing evidence, classifier error, provider exhaustion) degrades to the
  legacy prompt-driven path for that task and records a defect in the decision record.
- Circuit breakers (section 12) bound provider faults; the bounded recovery tracker bounds task faults.

### 16.4 Operator documentation

- Runtime flags, shadow mode usage, and metric collection are documented for operators (Dev 4 docs shipped
  with the rollout PRs).
- Every promotion is preceded by a Dev 4 report (section 18).

### 16.5 Rollback plan

- Rollback = flip the routing flag off; the legacy harness is always present and always the fallback.
- Decision records (section 13) let operators identify which tasks were routed by the candidate so affected
  work can be re-run on the legacy path.
- No data migration is required for rollback: decision records are additive events; removing routing
  activation never corrupts Dev 2 state.

---

## 17. Ownership Boundaries

Exact ownership table. Dev 4 does not modify any Dev 1/2/3-owned path without routing through the owning
developer.

| Area | Owner |
|---|---|
| SSE / streaming / UI | Dev 1 |
| Master plan, state machine, task contracts, completion engine, recovery, context store, telemetry persistence | Dev 2 |
| FDX (Rust native `crates/fdx/`, index inspection, FDX tooling) | Dev 3 |
| Routing decision layer (`src/orchestration/routing/`) | Dev 4 |
| Scheduling, models, capabilities | Dev 4 |
| Tests under `tests/routing/` | Dev 4 |
| Routing benchmarks under `scripts/` (routing benchmarks) | Dev 4 |
| This document | Dev 4 |

**Interfaces consumed by Dev 4 (read-only usage of Dev 2/3):**

- Dev 2: events (`src/orchestration/events/`), persistence ports, completion, verification, evidence,
  idempotency.
- Dev 3: capability metadata and FDX index inspection.

**Interfaces Dev 4 does not own or modify:**

- `src/orchestration/contracts/`, `completion/`, `persistence/`, `projections/`, `streaming/`, `api/`
  (Dev 2/3 frozen sub-domains).
- `src/services/heidi-execution-policy.ts` and `src/services/model-router.ts` (legacy harness, untouched).
- `src/services/canonical-registry.ts` (single source of truth; Dev 4 derives from it, does not fork it).

---

## 18. Per-Task Reporting

**Status: planned (report format mandatory for every Dev 4 campaign and PR).**

Every Dev 4 task, program, and campaign ends with a report in this format.

### 18.1 Header

```
Developer: Dev 4
Task:        <task id / title>
Program:     <program or stacked-work wave>
Campaign:    <campaign id, if part of a benchmark campaign>
Harness:     <harness version>
```

### 18.2 Provenance

```
Branch:      <branch>
Base SHA:    <base SHA>
Final SHA:   <final SHA>
PR:          <PR number / link>
Sessions:    <count>            Stages: <pipeline stages executed>
```

### 18.3 Decisions

```
Classification:  <TaskClass>            Confidence: <0-100>
Scores:          complexity=<n> ambiguity=<n> risk=<n>
Strategy:        <canonical ExecutionStrategy>
Delegation:      <decision summary + budget-table compliance>
Specialists:     <list + counts vs budget>
DAG:             <parallelism graph / serialization summary>
Model selections:<tier chain + reason codes>
Provider fallback:<fallback events + health scores>
```

### 18.4 Execution telemetry

```
Tokens:        <in/out totals>          Cost:   <USD estimate>
Tool calls:    <count>                  Duration: <wall time>
Retries:       <count, with idempotency flags>
Guard blocks:  <count of governance blocks hit>
Stability defects: <count + descriptions>
Repeated-run consistency: <% same-input-same-decision>
Exact-SHA CI:  <CI status at the exact final SHA, not a later SHA>
```

### 18.5 Readiness

```
Readiness scores (0-10 each):
  - Determinism    <0-10>
  - Evidence       <0-10>
  - Safety         <0-10>
  - Cost           <0-10>
  - Reproducibility <0-10>

Merge recommendation: <APPROVE / REQUEST CHANGES> <one-paragraph rationale>
```

A task is not considered done until the report exists, the metrics in section 15 are populated for the
campaign, and the merge recommendation is stated.

---

## Appendix: Verification

- This document covers all 18 sections: current architecture, prompt-driven weaknesses, target architecture,
  task taxonomy, scoring model, strategy contracts, capability registry, delegation rules, specialist
  budgets/scheduling, model tiers, escalation policy, provider resilience, decision provenance, shadow mode,
  evaluation corpus, fault handling/rollout/rollback, ownership boundaries, per-task reporting.
- Real paths referenced: `src/services/heidi-execution-policy.ts`, `src/services/model-router.ts`,
  `src/services/canonical-registry.ts`, `src/index.ts`, `src/services/supervisor-binding.ts`,
  `src/orchestration/` (contracts, events, persistence, completion, verification, evidence, idempotency,
  streaming, api, projections).
- Statuses: contracts/classifier/scoring = implemented in PR 1 (inactive at baseline `5809fcf`); strategy,
  capabilities, delegation, scheduling, models, providers, shadow, evaluation corpus, reporting = planned.
