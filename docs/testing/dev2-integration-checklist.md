# Dev 2 Integration Validation Checklist

**Purpose:** Validate that persistence adapters, runtime integration, and system
integration preserve Dev 2 domain invariants.

**Scope:** Every item must pass before Dev 2 signs off on the final integration merge.

---

## 1. SQLite Persistence

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 1.1 | Contract family round-trip | Save a family with 3 versions, load it back, all versions present | Integration test | All 3 versions loaded with correct fields |
| 1.2 | Verification run round-trip | Save a run with 5 results, load by run ID | Integration test | All 5 results returned |
| 1.3 | Evidence round-trip | Save evidence, archive it, load it — content preserved | Integration test | Content unchanged after archive |
| 1.4 | Approval round-trip | Create request, submit decision, load both | Integration test | Request + decision loaded correctly |
| 1.5 | Override round-trip | Create, approve, consume, load — status = consumed | Integration test | Status is `consumed`, `consumedByDecisionId` set |
| 1.6 | Completion decision round-trip | Save evaluation + decision, load by ID | Integration test | Decision loaded with matching evaluation |
| 1.7 | Idempotency reservation round-trip | Reserve, complete, load by scoped key | Integration test | Status = `completed`, resultId set |

---

## 2. Replay

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 2.1 | Identical decision on replay | Same command twice → second returns same decision ID, outcome, timestamps | Integration test | Decision IDs match exactly |
| 2.2 | Zero duplicate events on replay | Replayed command returns `events: []` | Integration test | Events array is empty |
| 2.3 | Event IDs stable on replay | Same command → same event IDs (if replayed) | Integration test | Event IDs match first execution |
| 2.4 | Missing result integrity error | Completed idempotency record references missing decision → typed error | Integration test | `IdempotencyIntegrityError` thrown |
| 2.5 | Completed reservation blocks retry | After completion, same command → replay, not new execution | Integration test | Second call returns `replayed: true` |

---

## 3. Rollback

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 3.1 | Evaluation rollback | Fail after `saveEvaluation` → no evaluation persists | Integration test | Evaluation not found after rollback |
| 3.2 | Decision rollback | Fail after `saveDecision` → no decision persists | Integration test | Decision not found after rollback |
| 3.3 | Override consumption rollback | Fail after `consume` → override returns to `approved` | Integration test | Override status is still `approved` |
| 3.4 | Event append rollback | Fail after event append → no events persisted | Integration test | Event store empty for aggregate |
| 3.5 | Idempotency reservation rollback | Fail after `tryReserve(acquired)` → reservation released | Integration test | Reservation status is `released` |
| 3.6 | Full transaction rollback | Fail at any point → no partial state remains | Integration test | All stores clean for the given run |

---

## 4. Event Ordering

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 4.1 | Completion event order | `CompletionEvaluated` before `CompletionApproved` | Event store query | Order preserved |
| 4.2 | OverrideConsumed order | `OverrideConsumed` emitted in same order as overrides consumed | Event store query | Order matches consumption |
| 4.3 | Deterministic ordering | Same command → same event order | Replay comparison | Identical event sequence |
| 4.4 | No interleaved events | No events from other aggregates between completion events | Event store query | Contiguous for the aggregate |

---

## 5. Optimistic Concurrency

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 5.1 | Approval version conflict | Two concurrent transitions on same request → one succeeds, one fails | Concurrency test | Second caller gets `ConcurrencyError` |
| 5.2 | Override CAS conflict | Two concurrent consume calls → one succeeds | Concurrency test | Consume with stale version fails |
| 5.3 | Idempotency reservation conflict | Two concurrent `tryReserve` with same key → one `acquired`, one `in_progress` | Concurrency test | Second gets `in_progress` |
| 5.4 | Decision duplicate conflict | Two `saveDecision` with same ID → second fails | Integration test | Duplicate key error |

---

## 6. Reservation Lifecycle

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 6.1 | Acquired → completed | Normal flow: `tryReserve(acquired)` → `completeReservation` → status `completed` | Integration test | Final status is `completed` |
| 6.2 | Acquired → released | Failure flow: `tryReserve(acquired)` → `releaseReservation` → status `released` | Integration test | Final status is `released` |
| 6.3 | Released key retry | After release, same key can be re-reserved | Integration test | Second `tryReserve` returns `acquired` |
| 6.4 | Completed key rejection | After completion, same key cannot be overwritten | Integration test | `tryReserve` returns `completed` |
| 6.5 | Different payload rejection | Same key, different payload → `conflict` | Integration test | `tryReserve` returns `conflict` |

---

## 7. Override Consumption

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 7.1 | Exact version consumes exactly once | Correct `expectedVersion` → consume succeeds | Integration test | Status = `consumed` |
| 7.2 | Stale version rejected | Wrong `expectedVersion` → `ConcurrencyError` | Integration test | Transaction rolls back |
| 7.3 | Already consumed rejected | Second consume on consumed override fails | Integration test | Error thrown |
| 7.4 | Revoked/expired rejected | Consume on non-approved override fails | Integration test | Error thrown |
| 7.5 | Rollback restores state | After failed consume, override is still `approved` | Integration test | Status = `approved` |

---

## 8. Approval Persistence

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 8.1 | Approval decision immutable | After creation, decision fields cannot change | Integration test | Object frozen or stored immutable |
| 8.2 | Approval lifecycle enforced | `rejected` → `approved` transition fails | Integration test | Error thrown |
| 8.3 | Approval binding preserved | `taskRunId`, `sha`, `contractVersionId` stored correctly | Integration test | All binding fields match |
| 8.4 | Authority level typed | `requesterAuthority` and `approverAuthority` are `AuthorityLevel` | TypeScript compilation | Compiles without `as any` |

---

## 9. Contract Activation

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 9.1 | Draft → activated | Valid draft activates with timestamp | Integration test | Status = `activated`, `activatedAt` set |
| 9.2 | Incomplete draft rejected | Empty specification → activation fails | Integration test | `IncompleteDraftError` thrown |
| 9.3 | One-active-version | Second activation while one active → fails | Integration test | `ActivationError` thrown |
| 9.4 | Immutability after activation | Activated contract spec cannot change | Integration test | `ImmutableContractError` thrown |
| 9.5 | Historical access | Old versions remain accessible after supersession | Integration test | All versions present in family |

---

## 10. Stale SHA Detection

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 10.1 | Stale result detected | Result with `targetSha !== currentSha` → stale | Unit test | `isResultStale` returns `true` |
| 10.2 | Stale evidence rejected | Archived or wrong-SHA evidence → not current | Unit test | `isEvidenceCurrent` returns `false` |
| 10.3 | SHA mismatch blocks completion | Cross-SHA verification → gate 2 fails | Integration test | `CURRENT_SHA_MISMATCH` failure code |
| 10.4 | Cross-run evidence fails | Evidence from wrong run → fails evidence gate | Integration test | Gate 6 fails |

---

## 11. Idempotency Replay

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 11.1 | Same payload → replay | Identical command → `replayed: true` | Integration test | Second call returns `replayed: true` |
| 11.2 | Replay returns existing result | Replayed command returns original decision | Integration test | Decision IDs match |
| 11.3 | No side effects on replay | Replay does not create new decisions, events, or consumption | Integration test | Same stored state before and after |
| 11.4 | Same key, different payload → conflict | Payload change → `IdempotencyConflictError` | Integration test | Typed error thrown |
| 11.5 | Concurrent same payload → one replay | Two simultaneous identical commands → one `acquired`, one `completed` | Concurrency test | Exactly one new decision created |

---

## 12. Duplicate Request Rejection

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 12.1 | Duplicate approval requests | Same idempotency key → second returns existing | Integration test | Not duplicated |
| 12.2 | Duplicate override requests | Same idempotency key → second returns existing | Integration test | Not duplicated |
| 12.3 | Duplicate completion requests | Same idempotency key → existing decision returned | Integration test | No new decision created |
| 12.4 | Concurrent duplicate completion | Two simultaneous completion commands → one decision | Concurrency test | Exactly one decision persisted |

---

## 13. Recovery After Failure

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 13.1 | Retry after rollback succeeds | Failed command → release → retry → succeeds | Integration test | Decision created on retry |
| 13.2 | No partial state after crash | Crash mid-transaction → no orphaned records | Recovery test | Stores consistent |
| 13.3 | Released key does not block | Released reservation → retry with same key succeeds | Integration test | Second call `acquired` |

---

## 14. Domain Event Append Contract

| # | Check | Expected Behaviour | Validation Method | Pass Criteria |
|---|---|---|---|---|
| 14.1 | Events appended inside transaction | Events persisted only if transaction commits | Integration test | After rollback, no events found |
| 14.2 | `appendMany` is atomic | Either all events appended or none | Integration test | Partial append not possible |
| 14.3 | Event payload is frozen | Caller cannot mutate payload after append | API test | Payload is `Object.frozen` |
| 14.4 | Event fields match schema | All required fields present and typed | Schema validation | No missing fields |

---

## Summary

| Category | Total Checks | Pass Required | Notes |
|---|---|---|---|
| SQLite Persistence | 7 | 7 | All round-trips must work |
| Replay | 5 | 5 | Determinism is critical |
| Rollback | 6 | 6 | No partial state |
| Event Ordering | 4 | 4 | Deterministic and contiguous |
| Optimistic Concurrency | 4 | 4 | CAS must be strict |
| Reservation Lifecycle | 5 | 5 | No lifecycle ambiguity |
| Override Consumption | 5 | 5 | CAS is critical |
| Approval Persistence | 4 | 4 | Immutability is required |
| Contract Activation | 5 | 5 | Core invariant |
| Stale SHA | 4 | 4 | Security invariant |
| Idempotency Replay | 5 | 5 | No duplicate effects |
| Duplicate Rejection | 4 | 4 | Idempotency safety |
| Recovery | 3 | 3 | Resilience |
| Event Append | 4 | 4 | Transaction boundary |
| **Total** | **65** | **65** | All must pass |
