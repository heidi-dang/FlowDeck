# Phase 5 — Dead-Letter Subscriber Notification Audit

**Date:** 2026-08-08  
**Auditor:** cptr  
**Scope:** `src/orchestration/services/outbox-worker.ts`, `tests/orchestration/dead-letter-notification.test.ts`

---

## Summary

**The Phase 5 dead-letter notification gap is fully closed.** The implementation is correct, complete, and verified by a passing end-to-end test.

---

## Findings

### 1. Implementation — `OutboxWorker.processBatch()` (lines 123–168)

On every delivery failure, `processBatch` already:

1. **Increments `attemptCount`** and calls `deliverySink.markFailed(id, attemptCount, errorMessage, maxRetries)`.
2. **Guards on terminal exhaustion** — when `attemptCount >= maxRetries` (default 3):
   - Calls `deliverySink.recordDeadLetter(...)` to write the durable `dead_letter_events` row.
   - Publishes an `outbox.dead_letter` event on the `IEventBus` with the full diagnostic payload:
     - `outboxId`, `eventId`, `eventType`, `destination`, `attemptCount`, `maxRetries`, `lastError`, `payload`.
3. **Swallows subscriber errors** in an inner try/catch — dead-letter notification failure cannot disrupt the batch.

The notification code is at `outbox-worker.ts:143–167`. No stub, no placeholder — it is production code.

### 2. Test — `tests/orchestration/dead-letter-notification.test.ts`

The test exercises the exact terminal-failure path end-to-end against a real SQLite database:

| Assertion | Value verified |
|---|---|
| `result.failed` | `1` |
| `deadLettersEmitted.length` | `1` |
| `deadLettersEmitted[0].type` | `"outbox.dead_letter"` |
| `deadLettersEmitted[0].data.outboxId` | `"outbox-dl-1"` |
| `deadLettersEmitted[0].data.lastError` | contains `"Permanent delivery failure"` |
| `deliverySink.countByStatus("failed")` | `1` |

The record is pre-seeded with `retry_count = 2`, so the first `processBatch` call brings `attemptCount` to `3 >= maxRetries(3)` and triggers the notification. All 6 assertions pass.

### 3. Test Results

```
tests/orchestration/dead-letter-notification.test.ts:
  ✓ Dead-Letter Event Subscriber Notification (Phase 5 Gap) > records dead letter and emits outbox.dead_letter event on terminal retry failure [28ms]

1 pass, 0 fail — 6 expect() calls
```

Companion suites also pass clean:

```
tests/orchestration/outbox-worker.test.ts         — 4 pass
tests/orchestration/delivery/sqlite-delivery-sink.test.ts — 18 pass
Total: 22 pass, 0 fail
```

---

## Completion Matrix Update

Phase 5 has been updated from **95% / gap listed** to **100% / no gaps**:

| Field | Before | After |
|---|---|---|
| `percent` | 95 | **100** |
| `gaps` | `["Dead-letter event subscriber notification hooks for terminal failures"]` | `[]` |
| `keyDeliverables` | 4 items | **5 items** (dead-letter notification added) |
| `evidence` | 5 paths | **6 paths** (`dead-letter-notification.test.ts` added) |
| `summary` | mentions retry/failure | mentions dead-letter notification |

Both `completion-matrix.json` and the generated `completion-matrix.md` have been updated.  
`node scripts/verify-completion-matrix.mjs --write` exited 0; report regenerated.

---

## No Code Changes Required

The implementation was already in production. This audit confirms it and closes the tracking gap.
