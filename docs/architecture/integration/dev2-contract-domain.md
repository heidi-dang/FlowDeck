# Dev 2 Contract Domain — Integration Specification

**Author:** Dev 2 (Contract Domain)
**Status:** Published
**Branch:** `dev2/orchestration-contract-domain`
**SHA:** `ffff7585714bf3241fb1fb08491cdad8fd6c0e5e`
**PR:** [#43](https://github.com/heidi-dang/FlowDeck/pull/43)

---

## 1. Domain Ownership

Dev 2 owns the following sub-domains. No other developer may modify these without
Dev 2 review and approval.

| Sub-domain | Source root | Tests | Status |
|---|---|---|---|
| Contract | `src/orchestration/contracts/` | 65 | Frozen |
| Verification | `src/orchestration/verification/` | 37 | Frozen |
| Evidence | `src/orchestration/evidence/` | 32 | Frozen |
| Approval | `src/orchestration/approval/` | 26 | Frozen |
| Override | `src/orchestration/override/` | 15 | Frozen |
| Completion | `src/orchestration/completion/` | 46 | Frozen |
| Idempotency | `src/orchestration/idempotency/` | 14 | Frozen |
| Domain Events | `src/orchestration/events/` | (integrated) | Frozen |
| Common/Ports | `src/orchestration/common/ports/` | — | Frozen |

**Total:** 209 tests across 10 test files — all pass.

---

## 2. Repository Contracts

Every repository method is listed with its inputs, outputs, transactional
expectations, concurrency behaviour, failure modes, and invariants.

### 2.1 ContractRepository

**File:** `src/orchestration/contracts/ports/contract-repository.ts`

| Method | Input | Output | Atomic | CAS | Tx | Replay-safe |
|---|---|---|---|---|---|---|
| `saveFamily` | `ContractFamily` | `void` | Required | No | Yes | Yes |
| `getFamily` | `familyId: string` | `ContractFamily \| undefined` | No | No | Yes | Yes |
| `listFamilies` | — | `ContractFamily[]` | No | No | Yes | Yes |
| `deleteFamily` | `familyId: string` | `void` | Required | No | Yes | Yes |

**Invariants:**
- `ContractFamily.versions` are ordered by `version` ascending.
- `ContractVersion` is immutable once `status === "activated"`.
- At most one active version per family (enforced by activation policy, not persistence).
- Family reconstruction must preserve all versions — historical accessibility is required.

### 2.2 VerificationRepository

**File:** `src/orchestration/verification/ports/verification-repository.ts`

| Method | Input | Output | Atomic | CAS | Tx | Replay-safe |
|---|---|---|---|---|---|---|
| `saveRun` | `VerificationRun` | `void` | Required | No | Yes | Yes |
| `getRun` | `runId: string` | `VerificationRun \| undefined` | No | No | Yes | Yes |
| `listRunsByContractVersion` | `contractVersionId: string` | `VerificationRun[]` | No | No | Yes | Yes |
| `saveResult` | `VerificationResult` | `void` | Required | No | Yes | Yes |
| `getResult` | `resultId: string` | `VerificationResult \| undefined` | No | No | Yes | Yes |
| `listResultsByRun` | `runId: string` | `VerificationResult[]` | No | No | Yes | Yes |
| `listResultsByContractVersion` | `contractVersionId: string` | `VerificationResult[]` | No | No | Yes | Yes |

**Invariants:**
- `VerificationResult` is immutable once `isTerminal` is true.
- `targetSha` must be persisted exactly as supplied — SHA matching is a domain policy.
- Results from different runs must remain distinguishable by `runId`.

### 2.3 EvidenceRepository

**File:** `src/orchestration/evidence/ports/evidence-repository.ts`

| Method | Input | Output | Atomic | CAS | Tx | Replay-safe |
|---|---|---|---|---|---|---|
| `saveEvidence` | `Evidence` | `void` | Required | No | Yes | Yes |
| `getEvidence` | `evidenceId: string` | `Evidence \| undefined` | No | No | Yes | Yes |
| `listEvidenceByRun` | `runId: string` | `Evidence[]` | No | No | Yes | Yes |
| `listEvidenceByCriterion` | `criterionId: string` | `Evidence[]` | No | No | Yes | Yes |
| `listEvidenceBySha` | `sha: string` | `Evidence[]` | No | No | Yes | Yes |
| `saveLink` | `EvidenceLink` | `void` | Required | No | Yes | Yes |
| `listLinksByEvidence` | `evidenceId: string` | `EvidenceLink[]` | No | No | Yes | Yes |

**Invariants:**
- Evidence content is immutable after creation.
- Archived evidence must retain all fields including `content` — archiving is a status change, not a deletion.
- `sha` binding must be preserved exactly.

### 2.4 ApprovalRepository

**File:** `src/orchestration/approval/ports/approval-repository.ts`

| Method | Input | Output | Atomic | CAS | Tx | Replay-safe |
|---|---|---|---|---|---|---|
| `saveRequest` | `ApprovalRequest` | `void` | Required | Yes (version) | Yes | Yes |
| `getRequest` | `requestId: string` | `ApprovalRequest \| undefined` | No | No | Yes | Yes |
| `listRequestsByRun` | `taskRunId: string` | `ApprovalRequest[]` | No | No | Yes | Yes |
| `saveDecision` | `ApprovalDecision` | `void` | Required | No | Yes | Yes |
| `getDecision` | `decisionId: string` | `ApprovalDecision \| undefined` | No | No | Yes | Yes |
| `listDecisionsByRequest` | `requestId: string` | `ApprovalDecision[]` | No | No | Yes | Yes |
| `listDecisionsByRun` | `taskRunId: string` | `ApprovalDecision[]` | No | No | Yes | Yes |

**Invariants:**
- `ApprovalDecision` is deeply immutable after creation.
- `ApprovalRequest` has optimistic concurrency via `version` field — `saveRequest` must use CAS.
- Lifecycle transitions are enforced by domain; persistence must not allow invalid states.

### 2.5 OverrideRepository

**File:** `src/orchestration/override/ports/override-repository.ts`

| Method | Input | Output | Atomic | CAS | Tx | Replay-safe |
|---|---|---|---|---|---|---|
| `saveRequest` | `OverrideRequest` | `void` | Required | Yes (version) | Yes | Yes |
| `getRequest` | `requestId: string` | `OverrideRequest \| undefined` | No | No | Yes | Yes |
| `listRequestsByRun` | `taskRunId: string` | `OverrideRequest[]` | No | No | Yes | Yes |
| `listActiveOverridesByRun` | `taskRunId: string` | `OverrideRequest[]` | No | No | Yes | Yes |
| `listRequestsByGate` | `gateId: string` | `OverrideRequest[]` | No | No | Yes | Yes |
| `consume` | `requestId, decisionId, expectedVersion, consumedAt` | `void` | **Required** | **Required** | **Required** | Yes |

**`consume()` contract:**
- Must atomically transition override from `approved` → `consumed`.
- Must reject (throw `ConcurrencyError`) if `version !== expectedVersion`.
- Must reject if current status is not `approved`.
- Must reject if override does not exist.
- On rollback, override must return to `approved` state.
- `consumedByDecisionId` and `consumedAt` must be persisted.

### 2.6 CompletionRepository

**File:** `src/orchestration/completion/ports/completion-repository.ts`

| Method | Input | Output | Atomic | CAS | Tx | Replay-safe |
|---|---|---|---|---|---|---|
| `saveEvaluation` | `CompletionEvaluation` | `void` | Required | No | Yes | Yes |
| `getLatestEvaluation` | `contractVersionId` | `CompletionEvaluation \| undefined` | No | No | Yes | Yes |
| `listEvaluations` | `contractVersionId` | `CompletionEvaluation[]` | No | No | Yes | Yes |
| `saveDecision` | `CompletionDecision` | `void` | Required | Yes (duplicate id) | Yes | Yes |
| `getDecision` | `decisionId: string` | `CompletionDecision \| undefined` | No | No | Yes | Yes |
| `getLatestDecisionByRun` | `taskRunId: string` | `CompletionDecision \| undefined` | No | No | Yes | Yes |
| `listDecisionsByRun` | `taskRunId: string` | `CompletionDecision[]` | No | No | Yes | Yes |
| `supersedeDecision` | `previousDecisionId, newDecisionId` | `void` | Required | No | Yes | Yes |

**Invariants:**
- `CompletionDecision` is deeply immutable after creation.
- `saveDecision` must reject (throw) if a decision with the same `id` already exists.
- `supersedeDecision` must set the supersession link atomically with the new decision.
- Only the latest decision per run is considered current.

### 2.7 IdempotencyRepository

**File:** `src/orchestration/idempotency/ports/idempotency-repository.ts`

| Method | Input | Output | Atomic | CAS | Tx | Replay-safe |
|---|---|---|---|---|---|---|
| `tryReserve` | `commandType, taskRunId, idempotencyKey, payloadHash, createdAt` | `ReservationResult` | **Required** | No | Yes | Yes |
| `completeReservation` | `commandType, taskRunId, idempotencyKey, resultType, resultId, completedAt` | `void` | Required | Yes (status check) | Yes | Yes |
| `releaseReservation` | `commandType, taskRunId, idempotencyKey` | `void` | Required | Yes (status check) | Yes | Yes |
| `getByScopedKey` | `commandType, taskRunId, idempotencyKey` | `IdempotencyRecord \| undefined` | No | No | Yes | Yes |

**`ReservationResult` contract:**

```typescript
type ReservationResult =
  | { status: "acquired"; record: IdempotencyRecord }
  | { status: "completed"; record: IdempotencyRecord }
  | { status: "in_progress"; record: IdempotencyRecord }
  | { status: "conflict"; record: IdempotencyRecord; expectedPayloadHash: string; actualPayloadHash: string }
```

**Lifecycle:**
```
tryReserve → acquired → (execute command) → completeReservation → completed
tryReserve → acquired → (failure) → releaseReservation → released
tryReserve → completed → (replay existing result)
tryReserve → in_progress → (error: concurrent execution)
tryReserve → conflict → (error: different payload, same key)
```

**Invariants:**
- `tryReserve` is the single atomic entry point — no check-then-reserve race.
- A `completed` record must never be overwritten.
- A `released` record may be re-reserved.
- `completeReservation` and `releaseReservation` must reject if status is not `reserved`.

### 2.8 DomainEventAppender

**File:** `src/orchestration/events/ports/event-publisher.ts` (exported as `DomainEventAppender`)

| Method | Input | Output | Atomic | CAS | Tx | Replay-safe |
|---|---|---|---|---|---|---|
| `append` | `DomainEvent` | `void` | Required | No | Yes | Yes |
| `appendMany` | `DomainEvent[]` | `void` | Required | No | Yes | Yes |

**Invariants:**
- Events are appended inside the domain transaction — not delivered externally.
- Event ordering must be deterministic and match append order.
- On replay, events are NOT appended (returned as empty array).

### 2.9 UnitOfWork

**File:** `src/orchestration/common/ports/unit-of-work.ts`

```typescript
interface UnitOfWork {
  execute<T>(work: () => Promise<T>): Promise<T>
}
```

**Contract:**
- `execute` wraps the work function in a single database transaction.
- If the work function throws, the transaction is rolled back atomically.
- If the work function succeeds, the transaction is committed atomically.
- Nested `execute` calls may join the outer transaction or throw — behaviour must be documented.

---

## 3. Event Contracts

### 3.1 Approval Events

| Event | Producer | Trigger | Ordering | Payload | Replay |
|---|---|---|---|---|---|
| `ApprovalRequested` | `ApprovalService.createRequest` | New approval request created | Per aggregate | `requestId, taskRunId, gateId, sha` | Not replayed (idempotent) |
| `ApprovalGranted` | `ApprovalService.submitDecision` | Approval approved | Per aggregate | `decisionId, requestId, approver, authority` | Not replayed |
| `ApprovalRejected` | `ApprovalService.submitDecision` | Approval rejected | Per aggregate | `decisionId, requestId, approver, reason` | Not replayed |
| `ApprovalExpired` | (scheduled or explicit) | Expiry transition persisted | Per aggregate | `requestId, expiredAt` | Not replayed |
| `ApprovalRevoked` | (explicit revocation) | Revocation persisted | Per aggregate | `requestId, revokedAt` | Not replayed |

### 3.2 Override Events

| Event | Producer | Trigger | Ordering | Payload | Replay |
|---|---|---|---|---|---|
| `OverrideRequested` | `OverrideService.createRequest` | New override request | Per aggregate | `overrideId, gateId, taskRunId, sha` | Not replayed |
| `OverrideApproved` | `OverrideService.approveRequest` | Override approved | Per aggregate | `overrideId, approver, authority` | Not replayed |
| `OverrideRejected` | `OverrideService.rejectRequest` | Override rejected | Per aggregate | `overrideId, approver` | Not replayed |
| `OverrideExpired` | (scheduled or explicit) | Expiry transition | Per aggregate | `overrideId, expiredAt` | Not replayed |
| `OverrideRevoked` | (explicit revocation) | Revocation persisted | Per aggregate | `overrideId, revokedAt` | Not replayed |
| `OverrideConsumed` | `CompleteTaskRunService` | Override consumed in completion transaction | Per decision | `overrideId, decisionId, previousVersion, newVersion, consumedAt` | **Not emitted on replay** |

### 3.3 Completion Events

| Event | Producer | Trigger | Ordering | Payload | Replay |
|---|---|---|---|---|---|
| `CompletionEvaluated` | `CompleteTaskRunService` | Any completion evaluation | Per decision | `decisionId, allPassed, gateCount, passedGates` | **Not emitted on replay** |
| `CompletionApproved` | `CompleteTaskRunService` | Outcome = `completed` | Per decision | `decisionId, outcome, appliedOverrideIds, approvalIds` | **Not emitted on replay** |
| `CompletionBlocked` | `CompleteTaskRunService` | Outcome = `blocked` | Per decision | `decisionId, outcome, failureReasons` | **Not emitted on replay** |
| `CompletionRejected` | `CompleteTaskRunService` | Outcome = `rejected` | Per decision | `decisionId, outcome, failureReasons` | **Not emitted on replay** |
| `CompletionDecisionSuperseded` | (supersession path) | Decision superseded | Per aggregate | `previousDecisionId, newDecisionId` | Not replayed |

### 3.4 Common Event Fields

Every event includes:

| Field | Type | Description |
|---|---|---|
| `eventId` | `string` | Unique, deterministic on replay |
| `eventType` | `DomainEventType` | Canonical event type |
| `eventVersion` | `number` | Schema version (currently 1) |
| `aggregateType` | `string` | `Approval`, `Override`, or `Completion` |
| `aggregateId` | `string` | Persisted aggregate identifier |
| `aggregateVersion` | `number` | Aggregate version after transition |
| `taskRunId` | `string` | Owning task run |
| `contractFamilyId` | `string?` | Contract family if applicable |
| `contractVersionId` | `string?` | Contract version if applicable |
| `evaluatedSha` | `string?` | Evaluated SHA if applicable |
| `correlationId` | `string` | Command correlation ID |
| `causationId` | `string?` | ID of causing event |
| `occurredAt` | `string` | ISO-8601 from injected clock |
| `policyVersion` | `string` | Policy version at time of event |
| `actor` | `string` | Identity of acting user/system |
| `payload` | `Record<string, unknown>` | Frozen, event-specific data |

---

## 4. Integration Rules

### 4.1 What Dev 1 Must Preserve

| Invariant | Enforced by | Breaks if |
|---|---|---|
| Deep immutability of decisions/evidence | Domain + Repository | Repository mutates persisted records |
| SHA binding on results and evidence | Domain + Repository | SHA is truncated or lost |
| CAS on override consumption | Repository | Consume succeeds with stale version |
| CAS on approval versioning | Repository | Two transitions on same request |
| Idempotency reservation atomicity | Repository | Race condition on tryReserve |
| Transaction atomicity | UnitOfWork | Partial writes survive rollback |
| Event append ordering | DomainEventAppender | Events reordered on read |
| Replay returns no events | CompleteTaskRunService | Events emitted during replay |

### 4.2 What Dev 3 Must Preserve

| Invariant | Enforced by | Breaks if |
|---|---|---|
| CompleteTaskRunCommand structure | Domain | Actor/timestamp fields missing |
| VerificationRun lifecycle | Domain | Run status transitions invalid |
| Evidence SHA is supplied correctly | Domain | SHA comes from wrong source |
| Override lifecycle transitions | Domain | Invalid status transitions accepted |

### 4.3 What Dev 4 Must Preserve

| Invariant | Enforced by | Breaks if |
|---|---|---|
| Six-gate evaluation logic | Domain | Gate policy registry modified |
| Failure code types | Domain | Codes renamed without migration |
| Canonical hashing stability | Domain | Hash algorithm changes |

### 4.4 What Dev 5 Must Preserve

| Invariant | Enforced by | Breaks if |
|---|---|---|
| Branch naming convention | Repository | Branch diverges from `dev2/` prefix |
| PR targets `main` | GitHub | PR targets wrong base |
| Integration validation | Dev 2 sign-off | Merge without integration approval |

---

## 5. Adapter Requirements Matrix

| Repository | Atomic writes | CAS | Transaction | Replay-safe | Priority |
|---|---|---|---|---|---|
| `ContractRepository` | Yes | No | Yes | Yes | High |
| `VerificationRepository` | Yes | No | Yes | Yes | High |
| `EvidenceRepository` | Yes | No | Yes | Yes | High |
| `ApprovalRepository` | Yes | **Yes** (version) | Yes | Yes | High |
| `OverrideRepository` | Yes | **Yes** (consume) | **Required** | Yes | **Critical** |
| `CompletionRepository` | Yes | **Yes** (decision id) | Yes | Yes | **Critical** |
| `IdempotencyRepository` | **Yes (tryReserve)** | Yes (status) | Yes | Yes | **Critical** |
| `DomainEventAppender` | Yes | No | Yes | Yes | High |

---

## 6. Error Mapping

Domain errors must be mapped to persistence errors without losing type information:

| Domain Error | Persistence Error | When |
|---|---|---|
| `ConcurrencyError` | `ConcurrencyError` (same type) | CAS version mismatch |
| `OverrideConsumedError` | `PersistenceError` | Override already consumed |
| `IdempotencyConflictError` | `PersistenceError` | Payload hash mismatch |
| `IdempotencyInProgressError` | `PersistenceError` | Concurrent reservation |
| `TransactionError` | `TransactionError` | Commit/rollback failure |

---

## 7. Configuration

No domain configuration leaks into persistence. The following are domain-owned:

- `CanonicalHash` algorithm (SHA-256 via `Bun.CryptoHasher`)
- `PolicyVersion` values (`"1.0.0"`)
- `GatePolicyRegistry` (six gates with override policies)
- `AuthorityLevel` hierarchy (operator → system)
- `ApprovalPolicy` (self-approval defaults to deny)
