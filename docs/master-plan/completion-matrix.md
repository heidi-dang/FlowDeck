# FlowDeck Master Plan — Completion Matrix

> **Generated report** — do not edit by hand. Edit `completion-matrix.json` and run
> `npm run verify:completion-matrix -- --write` to regenerate.

- **Repository**: `heidi-dang/FlowDeck`
- **Branch**: `feat/orchestration-services-api`
- **Last measured**: `2026-08-08T00:00:00.000Z`
- **Overall completion (declared)**: **100%**
- **Overall completion (equal-weight rollup)**: 100%
- **Included phases**: `0`, `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9`, `11`, `12`
- **Excluded phases**: `10`

> Phase 10 (UI Integration) is explicitly out of scope for the current master-plan execution and is excluded from the overall percentage.

## Phase Status

| Phase | Name | Status | Completion | Key deliverables |
| :--- | :--- | :--- | ---: | :--- |
| 0 | Specification Freeze | ✅ completed | 100% | schema-v0.2.6.sql — frozen canonical schema (53 tables, 32+ triggers, indexes) |
| 1 | Persistence Foundation | ✅ completed | 100% | connection/database/provider — SQLite lifecycle |
| 2 | Contract System | ✅ completed | 100% | contracts domain (families/versions/requirements/criteria/gates) with hashing and policies |
| 3 | Runtime State Model | ✅ completed | 100% | domain runtime state model (task-run, assignment, session, context-item, runtime-requirement) |
| 4 | Event Store | ✅ completed | 100% | events table (global_sequence, UNIQUE(aggregate_type, aggregate_id, aggregate_version), correlation index) |
| 5 | Delivery Engine | ✅ completed | 100% | OutboxWorker — exclusively uses lease-based claim path (claimDue), retry accounting, idempotent delivery, malformed JSON detection |
| 6 | Verification & Evidence | ✅ completed | 100% | verification domain (sha-policy, stale-policy, rules) + services |
| 7 | Completion Engine | ✅ completed | 100% | CompleteTaskRunService + CompletionDecisionService — atomic completion evaluation |
| 8 | Orchestrator | ✅ completed | 100% | src/agents/architect.ts — delegation helpers |
| 9 | Runtime Services | ✅ completed | 100% | API controllers + routes + middleware (validation/error-handler/auth) |
| 10 | UI Integration | 🚫 out-of-scope | 0% | — |
| 11 | Production Hardening | ✅ completed | 100% | tests/orchestration/{chaos,concurrency,fault,negative,performance,compliance,harness,composition-deep} |
| 12 | Documentation & Governance | ✅ completed | 100% | docs/roadmap/heidi-flowdeck-upgrade.md — runtime upgrade roadmap |

## Phase Details

### Phase 0 — Specification Freeze (100%, completed)

The authoritative data model and contract-domain specification are frozen. Schema v0.2.6 defines 53 tables with immutability, consistency and integrity triggers; the Dev 2 contract-domain integration document fixes the domain vocabulary.

**Key deliverables:**

- schema-v0.2.6.sql — frozen canonical schema (53 tables, 32+ triggers, indexes)
- dev2-contract-domain.md — frozen contract-domain integration specification
- phase_0_3_verification_report.md — Dev 0.3 phase verification report
- docs/roadmap/heidi-flowdeck-upgrade.md — production runtime upgrade roadmap

**Evidence (repository paths):**

- `schema-v0.2.6.sql`
- `docs/architecture/integration/dev2-contract-domain.md`
- `phase_0_3_verification_report.md`
- `docs/roadmap/heidi-flowdeck-upgrade.md`

### Phase 1 — Persistence Foundation (100%, completed)

SQLite connection management, transactional access (TransactionManager, UnitOfWork), the migration runner with checksum-protected ledger, startup schema validation with diagnostics, retry policy and worktree-lease repository are fully implemented and verified.

**Key deliverables:**

- connection/database/provider — SQLite lifecycle
- transaction-manager + unit-of-work — atomic read/write scopes
- migration-runner + migration-registry — checksummed, transactional migrations
- validation.ts — startup schema diagnostics (tables/triggers/FK/integrity)
- worktree.ts — durable worktree-lease repository

**Evidence (repository paths):**

- `src/orchestration/persistence/transaction-manager.ts`
- `src/orchestration/persistence/unit-of-work.ts`
- `src/orchestration/persistence/migrations/migration-runner.ts`
- `src/orchestration/persistence/migrations/migration-registry.ts`
- `src/orchestration/persistence/validation.ts`
- `src/orchestration/persistence/repositories/worktree.ts`

### Phase 2 — Contract System (100%, completed)

Contract families, versions, requirements, acceptance criteria and gates are modeled in the contracts domain, persisted through SQLite adapters (contract_families, task_contracts, requirements, acceptance_criteria) and exposed via ContractService and API controller with immutability triggers.

**Key deliverables:**

- contracts domain (families/versions/requirements/criteria/gates) with hashing and policies
- sqlite-contract-adapter.ts — SqliteContractRepo / SqliteContractVersionRepo / SqliteRequirementRepo / SqliteCriterionRepo
- SqliteContractRepository (task_contracts) + ContractService + contract-controller
- contracts test suite (tests/orchestration/contracts)

**Evidence (repository paths):**

- `src/orchestration/contracts/domain`
- `src/orchestration/contracts/services`
- `src/orchestration/persistence/adapters/sqlite-contract-adapter.ts`
- `src/orchestration/services/contract-service.ts`
- `src/orchestration/api/controllers/contract-controller.ts`
- `tests/orchestration/contracts`

### Phase 3 — Runtime State Model (100%, completed)

The runtime state model (task runs, assignments, contracts, completion decisions) is persisted through production SQLite adapters with optimistic aggregate versioning (aggregate_version CAS) and SqliteTransactionalRunWriter for single-commit atomic writes.

**Key deliverables:**

- domain runtime state model (task-run, assignment, session, context-item, runtime-requirement)
- SqliteTaskRunAdapter — state transitions with optimistic concurrency (aggregate_version CAS)
- SqliteTransactionalRunWriter — run write path in a single transaction
- SqliteRunRepository + SqliteAssignmentRepo wired in production runtime composition

**Evidence (repository paths):**

- `src/domain/orchestration/runtime`
- `src/orchestration/persistence/adapters/sqlite-runtime-adapter.ts`
- `src/orchestration/persistence/adapters/sqlite-transactional-run-writer.ts`
- `src/orchestration/persistence/repositories/task-run.ts`
- `src/orchestration/composition.ts`

### Phase 4 — Event Store (100%, completed)

Durable SQLite event store with global sequencing, per-aggregate version uniqueness, correlation/causation tracking, transactional event+outbox append, and deterministic ReplayService executing over the event store with stream hash validation. Consumer offset persistence implemented with cursor commit, reset, pause, and block operations, wired into production composition.

**Key deliverables:**

- events table (global_sequence, UNIQUE(aggregate_type, aggregate_id, aggregate_version), correlation index)
- SqliteEventAppenderAdapter.appendEventWithOutbox — transactional event+outbox write with version CAS
- SqliteEventRepo + EventService — store + outbox + live bus publish
- ReplayService + SqliteReplayRepository — deterministic stream replay, hash validation, and state recording
- SqliteConsumerOffsetRepository — cursor commit (setOffset), cursor reset (resetOffset), pause (pauseOffset), block (blockOffset), wired in composition.ts

**Evidence (repository paths):**

- `src/orchestration/persistence/repositories/event.ts`
- `src/orchestration/services/event-service.ts`
- `src/orchestration/services/replay-service.ts`
- `src/orchestration/persistence/adapters/sqlite-replay-repository.ts`
- `src/orchestration/persistence/repositories/consumer-offset.ts`
- `tests/orchestration/consumer-offset-persistence.test.ts`
- `src/orchestration/composition.ts`

### Phase 5 — Delivery Engine (100%, completed)

Delivery engine features durable SqliteDeliverySink implementing IDeliverySink with lease-based atomic claiming (claimDue), worker identity leases, crash recovery lease-expiry reclaim (requeueExpiredLeases), idempotent delivery, retry/failure accounting in OutboxWorker, and dead-letter subscriber notification emitting outbox.dead_letter events on terminal retry exhaustion.

**Key deliverables:**

- OutboxWorker — exclusively uses lease-based claim path (claimDue), retry accounting, idempotent delivery, malformed JSON detection
- SqliteDeliverySink — durable delivery sink with atomic lease claiming, markDelivered, markFailed, and requeueExpiredLeases
- OutboxWorkerChecker — health checker for worker running state and pending outbox count
- Dead-letter subscriber notification — outbox.dead_letter event emitted on terminal retry failure (attemptCount >= maxRetries)
- Comprehensive test suite (tests/orchestration/outbox-worker.test.ts, tests/orchestration/delivery/sqlite-delivery-sink.test.ts, tests/orchestration/dead-letter-notification.test.ts)

**Evidence (repository paths):**

- `src/orchestration/services/outbox-worker.ts`
- `src/orchestration/persistence/adapters/sqlite-delivery-sink.ts`
- `src/orchestration/services/health-service.ts`
- `tests/orchestration/outbox-worker.test.ts`
- `tests/orchestration/delivery/sqlite-delivery-sink.test.ts`
- `tests/orchestration/dead-letter-notification.test.ts`

### Phase 6 — Verification & Evidence (100%, completed)

Verification policies (SHA-based and staleness-based), verification rules, verification results persistence (verification_results), and evidence lifecycle are integrated into SqliteVerificationRepo and VerificationService, fully wired in production composition.

**Key deliverables:**

- verification domain (sha-policy, stale-policy, rules) + services
- evidence domain (immutability, lifecycle, content addressing) + services
- SqliteVerificationRepoAdapter + SqliteVerificationRepo (verification_results)
- VerificationService + verification-controller wired in composition

**Evidence (repository paths):**

- `src/orchestration/verification`
- `src/orchestration/evidence`
- `src/orchestration/services/verification-service.ts`
- `src/orchestration/api/controllers/verification-controller.ts`
- `src/orchestration/composition.ts`

### Phase 7 — Completion Engine (100%, completed)

Completion engine evaluates task completion decisions, writes immutable completion_decisions rows, enforces immutability via repository updates throwing COMPLETION_DECISION_IMMUTABLE, and publishes completion events.

**Key deliverables:**

- CompleteTaskRunService + CompletionDecisionService — atomic completion evaluation
- SqliteCompletionRepo — persistent completion decisions with immutability enforcement
- CompletionService + completion-controller wired in production runtime composition

**Evidence (repository paths):**

- `src/orchestration/completion/services/complete-task-run-service.ts`
- `src/orchestration/completion/services/decision-service.ts`
- `src/orchestration/services/completion-service.ts`
- `src/orchestration/composition.ts`

### Phase 8 — Orchestrator (100%, completed)

ExecutionRegistry, agent task routing, delegation helpers, and production orchestration composition runtime (createProductionOrchestrationRuntime) assemble and wire the full services and persistence graph.

**Key deliverables:**

- src/agents/architect.ts — delegation helpers
- src/lib/task-routing.ts — task-type classification
- createProductionOrchestrationRuntime — fully assembled services graph (defined and tested)
- ExecutionRegistry — run handle registry

**Evidence (repository paths):**

- `src/agents/architect.ts`
- `src/lib/task-routing.ts`
- `src/orchestration/composition.ts`
- `src/orchestration/services/execution-registry.ts`

### Phase 9 — Runtime Services (100%, completed)

API controllers, HTTP routing, real OrchestrationMetrics (counters, histograms, gauges, JSON snapshot, Prometheus output), and HealthService with SqliteDbChecker, OutboxWorkerChecker, and ReplayServiceChecker registered in composition.

**Key deliverables:**

- API controllers + routes + middleware (validation/error-handler/auth)
- HealthService — checkHealth/checkReadiness/checkLiveness with SqliteDbChecker, OutboxWorkerChecker, and ReplayServiceChecker
- OrchestrationMetrics — real counters, gauges, histograms, JSON snapshot, and Prometheus formatting
- Services graph — fully assembled run/contract/assignment/completion/verification/event/replay/health services

**Evidence (repository paths):**

- `src/orchestration/api`
- `src/orchestration/services/health-service.ts`
- `src/orchestration/metrics/index.ts`
- `src/orchestration/composition.ts`
- `tests/orchestration/composition-deep.test.ts`

### Phase 10 — UI Integration (0%, out-of-scope)

Explicitly out of scope for this master-plan execution. No dashboard or management UI is planned in the current wave.

**Remaining gaps:**

- Out of scope — excluded from overall completion percentage

### Phase 11 — Production Hardening (100%, completed)

Extensive hardening evidence: chaos, concurrency, fault-injection, negative-path, performance, compliance, deep composition, delivery, and metrics test suites; pre-push verification pipeline; Dev 2 compatibility check.

**Key deliverables:**

- tests/orchestration/{chaos,concurrency,fault,negative,performance,compliance,harness,composition-deep}
- run-integration-matrix.mjs + verify-schema.mjs + validate-artifacts.mjs
- generate-orchestration-compliance.mjs (compatibility matrix + provenance)
- pre-push.mjs fast/full verification pipeline
- tsconfig.dev2-compat.json Dev 2 compatibility check

**Evidence (repository paths):**

- `tests/orchestration/chaos`
- `tests/orchestration/concurrency`
- `tests/orchestration/fault`
- `tests/orchestration/negative`
- `tests/orchestration/performance`
- `tests/orchestration/compliance`
- `tests/orchestration/composition-deep.test.ts`
- `scripts/pre-push.mjs`

### Phase 12 — Documentation & Governance (100%, completed)

Architecture documentation, dev2 contract domain spec, upgrade roadmap, and completion matrix generator/validator with evidence linkage and automated markdown generation.

**Key deliverables:**

- docs/roadmap/heidi-flowdeck-upgrade.md — runtime upgrade roadmap
- docs/architecture/integration/dev2-contract-domain.md — contract-domain spec
- docs/master-plan/completion-matrix.json — phase completion matrix
- scripts/verify-completion-matrix.mjs — reproducible validator/reporter

**Evidence (repository paths):**

- `docs/roadmap/heidi-flowdeck-upgrade.md`
- `docs/architecture/integration/dev2-contract-domain.md`
- `docs/master-plan/completion-matrix.json`
- `scripts/verify-completion-matrix.mjs`

---

_Generated by `scripts/verify-completion-matrix.mjs` from `completion-matrix.json` (schema 1.0)._
