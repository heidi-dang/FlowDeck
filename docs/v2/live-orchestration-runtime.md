# Live Orchestration Runtime Authority

## Completion is policy-authorized

`Run.phase = completed` is a terminal transition that is authorized only by the bound `CompletionPolicy` instance. A session becoming idle, a child reporting success, worker prose, or a passing verification result does **not** complete a run by itself. The policy reconstructs the current SQLite snapshot, validates the exact durable live-verification row, records a V15-extended `heidi_completion_reviews` decision, and performs the single phase/version compare-and-swap through `RunTransitionEngine`.

The completion review has a deterministic key containing the run ID, aggregate version, state fingerprint, verification ID, and policy version. The review, immutable `completion_decisions` record, `run.completed` event, and outbox entry are written in the same completion transaction. A duplicate idle event therefore returns the original durable decision rather than emitting another completion.

| Requirement | Durable evidence required before completion |
| --- | --- |
| Run state | The run remains in `verifying` at the evaluated aggregate version and fingerprint. |
| Required work | At least one required work item exists and every required item is satisfied. |
| Child lifecycle | No active or failed required child and no unconfirmed cancellation remains. |
| Replacement barrier | No pending, handoff, ambiguous, or quarantined deferred replacement remains for the superseded run. |
| Verification | `live_orchestration` is passed, non-stale, state-bound, evidence-bearing, failure-free, and names a non-placeholder 40-character target SHA. |
| Concurrency | The final transition must win the `task_runs` phase/version CAS. |

## Failure and recovery behavior

The runtime fails closed when durable authority is missing, stale, malformed, or ambiguous. A failed verifier remains on existing recovery semantics; a passed verifier with a changed fingerprint is stale and cannot be used to complete. A completed run without a valid V15 policy review is treated as a diagnostic integrity failure, not as an idempotent completion success.

A malformed authority-bearing `verification_results` row is rejected during repository deserialization. In particular, malformed evidence or failure-reason JSON, invalid status/version/fingerprint, target SHA, or stale flag cannot normalize to an empty passing result. The CompletionPolicy independently validates the raw row as a defense-in-depth boundary.

## Deferred replacements and continuations

A deferred replacement never resumes while the superseded run retains unresolved native child termination or cancellation barriers. A malformed `routing_decision` is quarantined to `blocked`; it remains a lifecycle barrier and cannot fall back to a synthetic standard route. A later explicit replacement or cancellation may resolve that blocked intent through the existing durable repository flow.

Continuation dispatches use a durable identity and SQLite claim. Restart-surviving `pending` dispatches become `outcome_unknown`, so FlowDeck does not duplicate a prompt whose native outcome cannot be proven. Existing claims are validated against every identity field before reuse. After invoking the native client, both success and failure are written only with `status = 'pending'` compare-and-swap. A lost post-client race returns `dispatch_outcome_unknown`, which callers preserve as an ambiguity rather than retrying automatically.

| Durable record | Healthy state | Fail-closed state | Operator action |
| --- | --- | --- | --- |
| `verification_results` | Current passed live row with evidence and matching state identity | Missing, failed, stale, malformed, wrong run/type, or invalid target SHA | Re-run authoritative work and verification; do not edit the row to pass it. |
| `heidi_completion_reviews` | One completed review linked to the completion event | Running/failed/corrupt review, or completed run without valid policy JSON | Inspect the matching run and verification; resolve by a new valid state/verification cycle. |
| `deferred_replacements` | `resumed`, `superseded`, or `cancelled` after durable handoff resolution | `pending_termination`, `handoff_pending`, `handoff_outcome_unknown`, or `blocked` | Confirm child termination, then use explicit replacement/cancellation recovery. |
| `continuation_dispatches` | `dispatched` with a matching durable identity | `outcome_unknown` or `blocked` | Do not retry blindly; reconcile the user turn and issue an explicit new intent if needed. |

## Verification commands

Run the repository gates from the intended branch and a clean working tree.

```bash
npm run lint
npm run typecheck
node scripts/check-schema-generated.mjs
bun scripts/orchestration/verify-schema.mjs
bun test tests/live-verification-authority.test.ts tests/continuation-dispatch-durability.test.ts
bun test tests/orchestration-production-wiring.test.ts
```

The frozen-schema check covers V1 only. The live schema verifier includes V15 and expects **89 tables, 103 indexes, and 38 triggers**. Never modify V1–V14 to retrofit completion authority; V15 is the forward-only extension of the V10 completion-review ledger.

## Observability and incident triage

Completion policy decisions record a deterministic completion key, review ID, verification ID, state fingerprint, target SHA, event ID, and outbox idempotency key. Correlation begins with the run ID and is preserved by the `run.completed` event. For an incident, inspect the run snapshot and the four durable records above in that order. A lack of a `run.completed` event or a duplicate completion review is an integrity signal that should block automated progression.

> Never mark a run completed manually, mutate a completion review to `completed`, or convert `outcome_unknown` to `dispatched`. Each action would replace durable evidence with operator assertion and defeat the runtime authority model.
