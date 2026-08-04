# Dev 4 Routing and Model Handover Document

Archived at: archive/dev2-full-master-plan-ecbb226
Original commit: ecbb226db1150a2894e7fe46507d159a9fbb28ae
Note: Dev 4's canonical contracts and PR #107 remain authoritative.

## Archived Implementation Paths

The following routing files were archived in the dev2 branch:

- `src/orchestration/routing/task-classifier.ts`
- `src/orchestration/routing/strategy-selector.ts`
- `src/orchestration/routing/capability-registry.ts`
- `src/orchestration/routing/delegation-policy.ts`
- `src/orchestration/routing/work-dag.ts`
- `src/orchestration/routing/task-scheduler.ts`
- `src/orchestration/routing/model-tiers.ts`
- `src/orchestration/routing/model-routing-policy.ts`
- `src/orchestration/routing/provider-health.ts`
- `src/orchestration/routing/structured-response.ts`
- `src/orchestration/routing/index.ts`

## Potentially Reusable Ideas

### Task Classifier
11 classification dimensions:
- Read-only
- File count
- Domain count
- Verification surface
- Repository risk
- Production impact
- Security
- Migration
- CI failure
- Audit
- Ambiguity

### Strategy Selector
9 execution strategies available for task routing decisions.

### Capability Registry
Tracks per-agent capabilities:
- Mutation status
- Parallelism support
- Cancellation support

### Delegation Policy
Rejection rules for task delegation:
- Trivial task threshold
- Setup cost threshold
- Ownership overlap detection
- Capability disadvantage assessment

### Work DAG
- Capacity reservation mechanism for task scheduling

### Model Tiers
- Small (lightweight models)
- General (standard models)
- Strong (high-capability models)

### Model Routing Policy
- Least expensive historically successful model selection strategy

### Provider Health Monitor
- Circuit breaker pattern for provider resilience

### Structured Response Validation
- Typed output categories: routing, control, state
- Schema versioning support

## Known Risks

1. **Exploratory implementation**: The archived code was exploratory and may not meet production standards.

2. **Historical data assumption**: Model routing policy assumes historical success data exists and is reliable.

3. **Threshold tuning needed**: Delegation policy rejection thresholds may require empirical tuning for production use.

## Status

This document is **reference-only**. Do NOT cherry-pick or merge into Dev 4's branch. Dev 4's canonical contracts and PR #107 remain authoritative.

## Key Design Decisions

- **Task classification**: Deterministic approach using rules first; small model used only when confidence is insufficient.
- **Model selection**: Starts with least expensive model that historically succeeds.
- **Provider health**: Circuit breaker pattern to prevent cascading failures.
- **Structured responses**: Typed output (routing/control/state) with schema versioning for type safety.
