# FlowDeck Master Plan — Completion Matrix

> **Generated report** — do not edit by hand. Edit `completion-matrix.json` and run
> `npm run verify:completion-matrix -- --write` to regenerate.

- **Repository**: `heidi-dang/FlowDeck`
- **Branch**: `feat/orchestration-services-api`
- **Last measured**: `2026-08-08T00:00:00.000Z`
- **Overall completion (declared)**: **58%**
- **Overall completion (equal-weight rollup)**: 61%
- **Included phases**: `0`, `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9`, `11`, `12`
- **Excluded phases**: `10`

> Phase 10 (UI Integration) is explicitly out of scope for the current master-plan execution and is excluded from the overall percentage.

## Phase Status

| Phase | Name | Status | Completion | Key deliverables |
| :--- | :--- | :--- | ---: | :--- |
| 0 | Specification Freeze | ✅ completed | 95% | schema-v0.2.6.sql — frozen canonical schema (53 tables, 32+ triggers, indexes) |
| 1 | Persistence Foundation | ✅ completed | 90% | connection/database/provider — SQLite lifecycle |
| 2 | Contract System | ✅ completed | 90% | contracts domain (families/versions/requirements/criteria/gates) with hashing and policies |
| 3 | Runtime State Model | 🟡 partial | 60% | domain runtime state model (task-run, assignment, session, context-item, runtime-requirement, acceptance-criterion-state, worktree-leases) |
| 4 | Event Store | 🟡 partial | 45% | events table (global_sequence, UNIQUE(aggregate_type, aggregate_id, aggregate_version), correlation index) |
| 5 | Delivery Engine | 🟡 partial | 40% | OutboxWorker — claim batch, retry (attemptCount/maxRetries), idempotent delivery, failure marking, start/stop lifecycle |
| 6 | Verification & Evidence | 🟡 partial | 70% | verification domain (sha-policy, stale-policy, rules) + services |
| 7 | Completion Engine | 🟡 partial | 65% | CompleteTaskRunService — atomic completion command (12-step transactional sequence) |
| 8 | Orchestrator | 🟡 partial | 20% | src/agents/architect.ts — delegation helpers |
| 9 | Runtime Services | 🟡 partial | 45% | API controllers + routes + middleware (validation/error-handler/auth) |
| 10 | UI Integration | ⬜ not-started | 0% | — |
| 11 | Production Hardening | ✅ completed | 75% | tests/orchestration/{chaos,concurrency,fault,negative,performance,compliance,harness} |
| 12 | Documentation & Governance | 🟡 partial | 40% | docs/roadmap/heidi-flowdeck-upgrade.md — runtime upgrade roadmap |

## Phase Details

### Phase 0 — Specification Freeze (95%, completed)

The authoritative data model and contract-domain specification are frozen. Schema v0.2.6 defines 53 tables with immutability, consistency and integrity triggers; the Dev 2 contract-domain integration document fixes the domain vocabulary (contracts, verification, evidence, approval, override, completion, idempotency).

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

**Remaining gaps:**

- Phase 0.3 verification report is a snapshot; no automated cross-check against schema-v0.2.6.sql beyond check-schema-generated.mjs

### Phase 1 — Persistence Foundation (90%, completed)

SQLite connection management, transactional access (TransactionManager, UnitOfWork), the migration runner with checksum-protected ledger, startup schema validation with diagnostics, retry policy and worktree-lease repository are implemented and covered by dedicated phase tests.

**Key deliverables:**

- connection/database/provider — SQLite lifecycle
- transaction-manager + unit-of-work — atomic read/write scopes
- migration-runner + migration-registry — checksummed, transactional migrations
- validation.ts — startup schema diagnostics (tables/triggers/FK/integrity)
- worktree.ts — durable worktree-lease repository
- phase1-2 / phase1-3 / phase1-4 / phase1-5 tests

**Evidence (repository paths):**

- `src/orchestration/persistence/transaction-manager.ts`
- `src/orchestration/persistence/unit-of-work.ts`
- `src/orchestration/persistence/migrations/migration-runner.ts`
- `src/orchestration/persistence/migrations/migration-registry.ts`
- `src/orchestration/persistence/validation.ts`
- `src/orchestration/persistence/repositories/worktree.ts`
- `src/orchestration/persistence/__tests__/phase1-2-tests.mjs`
- `src/orchestration/persistence/__tests__/phase1-3-tests.mjs`
- `src/orchestration/persistence/__tests__/phase1-5-retry.mjs`

**Remaining gaps:**

- Session/context/ownership repositories exist only at domain-port level; SQLite adapters are partial (see Phase 3)

### Phase 2 — Contract System (90%, completed)

Contract families, versions, requirements, acceptance criteria and gates are modeled in the contracts domain, persisted through SQLite adapters (contract_families, task_contracts, requirements, acceptance_criteria) and exposed via the contract service and API controller. Immutability triggers protect the contract aggregate.

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

**Remaining gaps:**

- Contract lifecycle events are not fully propagated to consumers; lifecycle table (contract_lifecycle) has no production writer beyond family sync trigger

### Phase 3 — Runtime State Model (60%, partial)

The authoritative runtime state model (task runs, assignments, sessions, context items, runtime requirements, acceptance-criterion state, worktree ownership) exists as a domain layer with ports, event-store primitives and in-memory repositories. The production SQLite path currently persists task_runs and assignments with optimistic aggregate versioning; session, context-item, requirement and ownership persistence remain in-memory-only.

**Key deliverables:**

- domain runtime state model (task-run, assignment, session, context-item, runtime-requirement, acceptance-criterion-state, worktree-leases)
- runtime event-store domain (canonical serialization, commands, rehydration, in-memory store)
- SqliteTaskRunAdapter — state transitions with optimistic concurrency (aggregate_version CAS)
- SqliteTransactionalRunWriter — run write path in a single transaction
- SqliteRunRepository + SqliteAssignmentRepository

**Evidence (repository paths):**

- `src/domain/orchestration/runtime`
- `src/orchestration/persistence/adapters/sqlite-runtime-adapter.ts`
- `src/orchestration/persistence/adapters/sqlite-transactional-run-writer.ts`
- `src/orchestration/persistence/repositories/task-run.ts`
- `src/orchestration/persistence/repositories/repository.ts`

**Remaining gaps:**

- No SQLite adapters for SessionRepository, ContextItemRepository, RuntimeRequirementRepository, AcceptanceCriterionStateRepository, WorktreeOwnershipRepository wired into production
- Domain runtime repositories are in-memory (in-memory-repositories.ts / in-memory-store.ts); the production composition reads/writes SQLite directly without going through the domain state model

### Phase 4 — Event Store (45%, partial)

The events table is durable with global sequencing, per-aggregate version uniqueness, correlation/causation tracking and indexes. Transactional append of event + outbox entry is implemented. Replay is a stub: production composition wires UnsupportedReplayRepository which throws REPLAY_NOT_CONFIGURED (501), and consumer offsets are never advanced.

**Key deliverables:**

- events table (global_sequence, UNIQUE(aggregate_type, aggregate_id, aggregate_version), correlation index)
- SqliteEventAppenderAdapter.appendEventWithOutbox — transactional event+outbox write with version CAS
- SqliteEventRepository (global sequence, event_subscribers registration)
- EventService — store + outbox + live bus publish
- Event store domain (canonical serialization, commands, rehydration) — in-memory

**Evidence (repository paths):**

- `src/orchestration/persistence/repositories/event.ts`
- `src/orchestration/services/event-service.ts`
- `src/orchestration/persistence/adapters/sqlite-runtime-adapter.ts`
- `src/domain/orchestration/runtime/event-store`
- `tests/orchestration/replay/replay.test.ts`

**Remaining gaps:**

- Replay persistence not implemented — UnsupportedReplayRepository throws REPLAY_NOT_CONFIGURED
- ReplayService is create/list only; no runReplay execution over the event store
- consumer_offsets table has no production reader/writer
- Event store domain rehydration is not wired to the SQLite event store

### Phase 5 — Delivery Engine (40%, partial)

The outbox worker claims batches, reconstructs events, publishes through the event bus with retry counting, idempotent delivery marking and terminal failure marking. Claim/lease primitives (claimBatch, markDeliveredById) exist on the SQLite repository but are not used by the worker. There is no dead-letter record, no per-delivery record (event_deliveries), no lease-expiry reclaim and no consumer-offset advancement.

**Key deliverables:**

- OutboxWorker — claim batch, retry (attemptCount/maxRetries), idempotent delivery, failure marking, start/stop lifecycle
- SqliteOutboxRepository — create/update/find/claimNextBatch/markDelivered/markFailed
- claimBatch(workerId, batchSize, leaseSeconds) + markDeliveredById(id, key) primitives
- outbox-worker.test.ts + outbox-repository tests

**Evidence (repository paths):**

- `src/orchestration/services/outbox-worker.ts`
- `src/orchestration/persistence/adapters/sqlite-outbox-repository.ts`
- `tests/orchestration/outbox-worker.test.ts`
- `tests/orchestration/persistence/outbox-repository.test.ts`

**Remaining gaps:**

- Worker does not use lease-based claiming (claimBatch unused); no lease-expiry reclaim
- No event_deliveries rows written; no dead_letter_events on terminal failure
- No consumer offset advancement; subscriber processing not implemented
- Retry metadata not persisted between attempts in a crash-safe way

### Phase 6 — Verification & Evidence (70%, partial)

Verification policies (SHA-based and staleness-based), verification rules, evidence immutability (triggers) and evidence lifecycle are implemented with SQLite adapters (verification_results, evidence, evidence_lifecycle) and covered by tests. Evidence production wiring into the composition is thin: adapters exist in dev2-adapters but the services-layer evidence path is not fully connected.

**Key deliverables:**

- verification domain (sha-policy, stale-policy, rules) + services
- evidence domain (immutability, lifecycle, content addressing) + services
- SqliteVerificationRepoAdapter / SqliteEvidenceRepoAdapter (dev2-adapters)
- SqliteVerificationRepository (verification_results) + VerificationService + verification-controller
- verification + evidence test suites

**Evidence (repository paths):**

- `src/orchestration/verification`
- `src/orchestration/evidence`
- `src/orchestration/persistence/adapters/dev2-adapters.ts`
- `src/orchestration/services/verification-service.ts`
- `src/orchestration/api/controllers/verification-controller.ts`
- `tests/orchestration/verification`
- `tests/orchestration/evidence`

**Remaining gaps:**

- Evidence service not wired into production composition (no SqliteEvidenceRepository in services path)
- Verification policy enforcement not connected to run state transitions (verification_sha / verification gate)

### Phase 7 — Completion Engine (65%, partial)

The atomic six-gate completion command (CompleteTaskRunService) is fully implemented and heavily tested at the domain level: idempotency reservation, gate evaluation, override CAS-consume, approval validation, decision supersession, domain events and single-commit unit of work. However the production composition still wires the thin CRUD CompletionService; the six-gate engine is not connected to SQLite adapters or the API.

**Key deliverables:**

- CompleteTaskRunService — atomic completion command (12-step transactional sequence)
- CompletionDecisionService — six-gate evaluation + decision
- idempotency domain (tryReserve/complete/release, fingerprint hashing)
- override domain (CAS consume) + approval domain
- SQLite completion/override/idempotency/approval adapters in dev2-adapters
- completion test suite (tests/orchestration/completion)

**Evidence (repository paths):**

- `src/orchestration/completion/services/complete-task-run-service.ts`
- `src/orchestration/completion/services/decision-service.ts`
- `src/orchestration/idempotency`
- `src/orchestration/override`
- `src/orchestration/approval`
- `src/orchestration/persistence/adapters/dev2-adapters.ts`
- `tests/orchestration/completion`

**Remaining gaps:**

- CompleteTaskRunService is not wired into production composition — thin CompletionService remains the runtime completion path
- Six-gate engine uses in-memory repositories in tests; SQLite adapters not assembled into a production unit of work
- completion_decisions table lacks result/metadata columns; production adapter writes only basic fields

### Phase 8 — Orchestrator (20%, partial)

Agent delegation infrastructure exists (architect agent, task routing, delegation helpers) and the plugin performs ad-hoc orchestration today. The durable orchestration runtime (createProductionOrchestrationRuntime) is not called by the plugin runtime: there is no planner integration, no run/assignment lifecycle driving agent execution, no recovery coordinator and no completion coordinator wiring.

**Key deliverables:**

- src/agents/architect.ts — delegation helpers
- src/lib/task-routing.ts — task-type classification
- createProductionOrchestrationRuntime — fully assembled services graph (defined, not invoked)
- ExecutionRegistry — run handle registry

**Evidence (repository paths):**

- `src/agents/architect.ts`
- `src/lib/task-routing.ts`
- `src/orchestration/composition.ts`
- `src/orchestration/services/execution-registry.ts`

**Remaining gaps:**

- createProductionOrchestrationRuntime is never called by the plugin (hooks/agents/tools)
- No planner → delegation → agent execution → recovery → completion coordinator pipeline over the durable runtime
- No run lifecycle wiring into agent sessions or hooks

### Phase 9 — Runtime Services (45%, partial)

API controllers (run, assignment, contract, completion, verification, event, replay, health), health service (liveness/readiness/checks), streaming (SSE/WebSocket/live-updates) and the services layer are implemented and tested in isolation. Metrics are placeholders (snapshot() returns [] and Prometheus output is a placeholder string). The API surface is not mounted on any server, and the production runtime is not started by the plugin.

**Key deliverables:**

- API controllers + routes + middleware (validation/error-handler/auth)
- HealthService — checkHealth/checkReadiness/checkLiveness with dependency checkers
- streaming — SSE manager, WebSocket manager, live-updates, event-subscription
- OrchestrationMetrics — counters/gauges/histograms (snapshot/Prometheus are placeholders)
- services layer: run/contract/assignment/completion/verification/event/query/health services

**Evidence (repository paths):**

- `src/orchestration/api`
- `src/orchestration/services/health-service.ts`
- `src/orchestration/streaming`
- `src/orchestration/metrics/index.ts`
- `src/orchestration/services`

**Remaining gaps:**

- OrchestrationMetrics.snapshot() and toPrometheusText() return placeholders — not real metric output
- API not mounted (no HTTP server wiring; createProductionOrchestrationRuntime not started)
- Health checkers for DB/outbox/replay dependencies not registered in composition

### Phase 10 — UI Integration (0%, not-started)

Explicitly out of scope for this master-plan execution. No dashboard or management UI is planned in the current wave.

**Remaining gaps:**

- Out of scope — excluded from overall completion percentage

### Phase 11 — Production Hardening (75%, completed)

Extensive hardening evidence: chaos, concurrency, fault-injection, negative-path, performance and compliance test suites; orchestration integration matrix with per-dev-slot SHA provenance; schema verification script; artifact validation; pre-push fast/full verification pipeline; Dev 2 compatibility type-check.

**Key deliverables:**

- tests/orchestration/{chaos,concurrency,fault,negative,performance,compliance,harness}
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
- `scripts/orchestration/run-integration-matrix.mjs`
- `scripts/orchestration/verify-schema.mjs`
- `scripts/orchestration/validate-artifacts.mjs`
- `scripts/pre-push.mjs`

**Remaining gaps:**

- Integration matrix last run reported blocked_by_merge_conflict; needs a clean full-profile run
- Chaos/fault suites cover services layer but not the six-gate completion engine under fault injection

### Phase 12 — Documentation & Governance (40%, partial)

Architecture, roadmap, integration and verification documentation exist, and the dev2-contract-domain spec is documented. The master-plan completion matrix (this deliverable) adds phase-level completion governance with evidence linkage and a reproducible validator. Per-phase verification reports beyond Phase 0.3 are missing.

**Key deliverables:**

- docs/roadmap/heidi-flowdeck-upgrade.md — runtime upgrade roadmap
- docs/architecture/integration/dev2-contract-domain.md — contract-domain spec
- docs/master-plan/completion-matrix.{json,md} — phase completion matrix (this workstream)
- scripts/verify-completion-matrix.mjs — reproducible validator/reporter

**Evidence (repository paths):**

- `docs/roadmap/heidi-flowdeck-upgrade.md`
- `docs/architecture/integration/dev2-contract-domain.md`
- `docs/master-plan/completion-matrix.json`
- `docs/master-plan/completion-matrix.md`
- `scripts/verify-completion-matrix.mjs`

**Remaining gaps:**

- No per-phase verification reports (only Phase 0.3 exists)
- Completion matrix must be re-measured after each implementation wave (validator supports refresh)

---

_Generated by `scripts/verify-completion-matrix.mjs` from `completion-matrix.json` (schema 1.0)._
