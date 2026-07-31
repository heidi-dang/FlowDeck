# Phase 0.2 Integration Repair Matrix

**Base SHA**: `origin/main`
**Dev 1 SHA**: `unknown` (approx head of feat/orchestration-persistence-foundation from the integration)
**Dev 2 SHA**: `unknown` (approx head of feat/orchestration-contract-domain from the integration)

---

## 1. EventsRepository (EventStore Port)
* **Stable Failure ID**: `F-EVT-01`
* **Owning Developer**: Dev 1
* **Owning Branch**: `feat/orchestration-persistence-foundation`
* **Failing Suite/Test**: SQLite Production Integration Tests > EventsRepository Compliance (EventsRepository)
* **Expected Interface/Invariant**: Must implement the `EventStore` interface methods.
* **Observed Implementation**: `EventsRepository` class (Dev 1).
* **Missing Methods**:
  - `appendEvent`
  - `getEvents`
  - `getAllEvents`
* **Source File Requiring Repair**: `src/orchestration/persistence/repositories/event.ts`
* **Validation Test**: `tests/orchestration/compliance/contracts/event-store-contract.ts`
* **Upstream Dependency**: `EventStore` interface (Dev 2).
* **Blocker Type**: Compilation / Runtime Compliance.

---

## 2. SqliteContractAdapter (ContractRepository Port)
* **Stable Failure ID**: `F-CTR-01`
* **Owning Developer**: Dev 1
* **Owning Branch**: `feat/orchestration-persistence-foundation`
* **Failing Suite/Test**: SQLite Production Integration Tests > ContractRepository Compliance (SqliteContractAdapter)
* **Expected Interface/Invariant**: Must implement the `ContractRepository` interface methods.
* **Observed Implementation**: `SqliteContractAdapter` class (Dev 1).
* **Missing Methods**:
  - `saveFamily`
  - `getFamily`
  - `listFamilies`
  - `deleteFamily`
* **Source File Requiring Repair**: `src/orchestration/persistence/repositories/contract-adapter.ts`
* **Validation Test**: `tests/orchestration/compliance/contracts/contract-repository-contract.ts`
* **Upstream Dependency**: `ContractRepository` interface (Dev 2).
* **Blocker Type**: Compilation / Runtime Compliance.

---

## 3. EvidenceRepository
* **Stable Failure ID**: `F-EVD-01`
* **Owning Developer**: Dev 1
* **Owning Branch**: `feat/orchestration-persistence-foundation`
* **Failing Suite/Test**: SQLite Production Integration Tests > EvidenceRepository Compliance
* **Expected Interface/Invariant**: Implementation of `EvidenceRepository` required.
* **Observed Implementation**: Missing Implementation.
* **Missing Methods**:
  - `saveEvidence`
  - `getEvidence`
  - `listEvidenceByTaskRun`
* **Source File Requiring Repair**: Missing file (needs new repository).
* **Validation Test**: `tests/orchestration/compliance/contracts/evidence-repository-contract.ts`
* **Upstream Dependency**: None.
* **Blocker Type**: Runtime Compliance.

---

## 4. VerificationRepository
* **Stable Failure ID**: `F-VRF-01`
* **Owning Developer**: Dev 1
* **Owning Branch**: `feat/orchestration-persistence-foundation`
* **Failing Suite/Test**: SQLite Production Integration Tests > VerificationRepository Compliance
* **Expected Interface/Invariant**: Implementation of `VerificationRepository` required.
* **Observed Implementation**: Missing Implementation.
* **Missing Methods**:
  - `saveRun`
  - `getRun`
  - `listRunsByContractVersion`
  - `saveResult`
  - `getResult`
  - `listResultsByRun`
* **Source File Requiring Repair**: Missing file.
* **Validation Test**: `tests/orchestration/compliance/contracts/verification-repository-contract.ts`
* **Upstream Dependency**: None.
* **Blocker Type**: Runtime Compliance.

---

## 5. ApprovalRepository
* **Stable Failure ID**: `F-APP-01`
* **Owning Developer**: Dev 1
* **Owning Branch**: `feat/orchestration-persistence-foundation`
* **Failing Suite/Test**: SQLite Production Integration Tests > ApprovalRepository Compliance
* **Expected Interface/Invariant**: Implementation of `ApprovalRepository` required.
* **Observed Implementation**: Missing Implementation.
* **Missing Methods**:
  - `saveApproval`
  - `getApproval`
  - `listPendingApprovals`
* **Source File Requiring Repair**: Missing file.
* **Validation Test**: `tests/orchestration/compliance/contracts/additional-contracts.ts`
* **Upstream Dependency**: None.
* **Blocker Type**: Runtime Compliance.

---

## 6. OverrideRepository
* **Stable Failure ID**: `F-OVR-01`
* **Owning Developer**: Dev 1
* **Owning Branch**: `feat/orchestration-persistence-foundation`
* **Failing Suite/Test**: SQLite Production Integration Tests > OverrideRepository Compliance
* **Expected Interface/Invariant**: Implementation of `OverrideRepository` required.
* **Observed Implementation**: Missing Implementation.
* **Missing Methods**:
  - `saveOverride`
  - `getOverride`
  - `listActiveOverrides`
* **Source File Requiring Repair**: Missing file.
* **Validation Test**: `tests/orchestration/compliance/contracts/additional-contracts.ts`
* **Upstream Dependency**: None.
* **Blocker Type**: Runtime Compliance.

---

## 7. CompletionRepository
* **Stable Failure ID**: `F-CMP-01`
* **Owning Developer**: Dev 1
* **Owning Branch**: `feat/orchestration-persistence-foundation`
* **Failing Suite/Test**: SQLite Production Integration Tests > CompletionRepository Compliance
* **Expected Interface/Invariant**: Implementation of `CompletionRepository` required.
* **Observed Implementation**: Missing Implementation.
* **Missing Methods**:
  - `saveCompletion`
  - `getCompletion`
  - `listCompletionsByTaskRun`
* **Source File Requiring Repair**: Missing file.
* **Validation Test**: `tests/orchestration/compliance/contracts/additional-contracts.ts`
* **Upstream Dependency**: None.
* **Blocker Type**: Runtime Compliance.

---

## 8. IdempotencyRepository
* **Stable Failure ID**: `F-IDM-01`
* **Owning Developer**: Dev 1
* **Owning Branch**: `feat/orchestration-persistence-foundation`
* **Failing Suite/Test**: SQLite Production Integration Tests > IdempotencyRepository Compliance
* **Expected Interface/Invariant**: Implementation of `IdempotencyRepository` required.
* **Observed Implementation**: Missing Implementation.
* **Missing Methods**:
  - `saveReservation`
  - `getReservation`
  - `deleteReservation`
* **Source File Requiring Repair**: Missing file.
* **Validation Test**: `tests/orchestration/compliance/contracts/additional-contracts.ts`
* **Upstream Dependency**: None.
* **Blocker Type**: Runtime Compliance.

---

## 9. OutboxRepository
* **Stable Failure ID**: `F-OUT-01`
* **Owning Developer**: Dev 1
* **Owning Branch**: `feat/orchestration-persistence-foundation`
* **Failing Suite/Test**: SQLite Production Integration Tests > OutboxRepository Compliance
* **Expected Interface/Invariant**: Implementation of `OutboxRepository` required.
* **Observed Implementation**: Missing Implementation.
* **Missing Methods**:
  - `saveMessage`
  - `getUnpublishedMessages`
  - `markAsPublished`
* **Source File Requiring Repair**: Missing file.
* **Validation Test**: `tests/orchestration/compliance/contracts/additional-contracts.ts`
* **Upstream Dependency**: None.
* **Blocker Type**: Runtime Compliance.

---

## 10. UnitOfWork
* **Stable Failure ID**: `F-UOW-01`
* **Owning Developer**: Dev 1
* **Owning Branch**: `feat/orchestration-persistence-foundation`
* **Failing Suite/Test**: SQLite Production Integration Tests > UnitOfWork Compliance
* **Expected Interface/Invariant**: Implementation of `UnitOfWork` required.
* **Observed Implementation**: Missing Implementation.
* **Missing Methods**:
  - `begin`
  - `commit`
  - `rollback`
* **Source File Requiring Repair**: Missing file.
* **Validation Test**: `tests/orchestration/compliance/contracts/additional-contracts.ts`
* **Upstream Dependency**: None.
* **Blocker Type**: Transaction / Failure Recovery.

---

## 11. RuntimeStateMachine
* **Stable Failure ID**: `F-RSM-01`
* **Owning Developer**: Dev 2
* **Owning Branch**: `feat/orchestration-contract-domain`
* **Failing Suite/Test**: SQLite Production Integration Tests > RuntimeStateMachine Compliance
* **Expected Interface/Invariant**: Implementation of `RuntimeStateMachine` required.
* **Observed Implementation**: Missing Implementation.
* **Missing Methods**:
  - `transition`
  - `canTransition`
* **Source File Requiring Repair**: Missing file.
* **Validation Test**: `tests/orchestration/compliance/contracts/additional-contracts.ts`
* **Upstream Dependency**: None.
* **Blocker Type**: Compilation / Runtime Compliance.

---

## 12. Replay Processor
* **Stable Failure ID**: `F-REP-01`
* **Owning Developer**: Dev 2
* **Owning Branch**: `feat/orchestration-contract-domain`
* **Failing Suite/Test**: SQLite Production Integration Tests > Replay Compliance
* **Expected Interface/Invariant**: Implementation of `Replay` required.
* **Observed Implementation**: Missing Implementation.
* **Missing Methods**:
  - `replayFromStart`
  - `replayFromSequence`
* **Source File Requiring Repair**: Missing file.
* **Validation Test**: `tests/orchestration/compliance/contracts/additional-contracts.ts`
* **Upstream Dependency**: None.
* **Blocker Type**: Replay / Runtime Compliance.
