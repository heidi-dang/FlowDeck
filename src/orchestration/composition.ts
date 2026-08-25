/**
 * Production orchestration runtime composition.
 *
 * Wires the real dependency graph: SQLite adapters, shared ExecutionRegistry,
 * mandatory SqliteUnitOfWork, real SqliteOutboxRepository, and the outbox worker.
 * No in-memory fallback, no Map-backed repositories, no optional mutation-safety deps.
 */

import type { Database } from "bun:sqlite";
import type { TransactionManager } from "./persistence/transaction-manager";
import { ExecutionRegistry } from "./services/execution-registry";
import { SqliteUnitOfWork } from "./persistence/unit-of-work";
import { createTransactionManager } from "./persistence/transaction-manager";
import { InMemoryEventBus } from "./services/event-bus-impl";
import { OutboxWorker } from "./services/outbox-worker";
import { SqliteTaskRunAdapter } from "./persistence/adapters/sqlite-runtime-adapter";
import { SqliteContractAdapter } from "./persistence/adapters/sqlite-contract-adapter";
import { SqliteOutboxRepository } from "./persistence/adapters/sqlite-outbox-repository";
import { SqliteReplayRepository } from "./persistence/adapters/sqlite-replay-repository";
import { SqliteDeliverySink } from "./persistence/adapters/sqlite-delivery-sink";
import { SqliteTransactionalRunWriter } from "./persistence/adapters/sqlite-transactional-run-writer";
import {
  SqliteCompletionRepoAdapter,
  SqliteVerificationRepoAdapter,
  SqliteEventAppenderAdapter,
} from "./persistence/adapters/dev2-adapters";
import { RunService } from "./services/run-service";
import { ContractService } from "./services/contract-service";
import { AssignmentService } from "./services/assignment-service";
import { AssignmentBindingCoordinator } from "./execution/assignment-binding-coordinator";
import { VerificationService } from "./services/verification-service";
import { CompletionService } from "./services/completion-service";
import { ReplayService } from "./services/replay-service";
import { EventService } from "./services/event-service";
import {
  HealthService,
  SqliteDbChecker,
  OutboxWorkerChecker,
  ReplayServiceChecker,
} from "./services/health-service";
import {
  SqliteSessionRepository,
  SqliteContextItemRepository,
  SqliteConsumerOffsetRepository,
  SessionTurnRepository,
  TaskRunsRepository,
  SqliteDeferredReplacementRepository,
  InternalMessageProvenanceRepository,
} from "./persistence/repositories";
import type {
  IRunRepository,
  IContractRepository,
  IAssignmentRepository,
  IVerificationRepository,
  ICompletionRepository,
  IEventRepository,
  PaginatedResult,
} from "./services/ports";
import type { Run, UpdateRunInput, RunFilter } from "./types/runs";
import {
  mapRunStatusToTaskRunState,
  mapTaskRunStateToRunStatus,
  isValidPersistedPhase,
} from "./types/runs";
import type { Contract } from "./types/contracts";
import type { Assignment } from "./types/assignments";
import type { VerificationResult } from "./types/verification";
import type { Completion } from "./types/completion";
import type { OrchestrationEvent, EventFilter } from "./types/events";
import type { PagePaginationRequest } from "./types/pagination";
import { createRouterWithControllers } from "./api/routes";
import { OrchestrationError, ErrorCodes } from "./types/errors";
import { SqliteRoutingDecisionRepository } from "./routing/sqlite-store";
import { RoutingProjection } from "./services/routing-projection";
import { OrchestrationMetrics } from "./metrics";
import { SqliteExecutionRepository, ExecutionScheduler, GitWorktreeManager, ControlledIntegrationService, WorktreeExecutionService } from "./execution";
import { SqliteAssignmentExecutionBindingRepository } from "./execution/assignment-execution-binding-repository";
import { SqlitePerformanceRepository } from "./performance";
import { PerformanceProjection } from "./services/performance-projection";
import { RuntimeSnapshotService } from "./services/runtime-snapshot";
import { AuthoritativeRoutingService } from "./routing/authoritative";
import { RoutingRevisionService } from "./routing/routing-revision-service";
import { ChildExecutionLifecycleService } from "./services/child-execution-lifecycle-service";
import { SqliteNativeChildExecutionRepository } from "./persistence/repositories/native-child-execution";
import { ProgressObservationService } from "./services/progress-observation-service";
import { OrchestrationSnapshotService } from "./services/orchestration-snapshot-service";
import { RunTransitionEngine } from "./services/transition-engine";
import { CompletionPolicy } from "./services/completion-policy";
import { ContinuationPolicy, ContinuationDispatcher } from "./services/continuation-policy";
import { TokenBudgetRuntime } from "../services/token-budget-runtime";
import type { IsolatedWorkstreamExecutor } from "./execution/worktree-executor";
import type { CommandRegistry } from "./commands/domain/command-registry";
import type { DurableCommandExecutor, CommandFaultHook } from "./commands/services/durable-command-executor";
import { createCoreCommandRuntime } from "./commands/services/command-runtime";
import { RepoMaster } from "./repository/repo-master";

export interface ProductionOrchestrationRuntime {
  db: Database;
  executionRegistry: ExecutionRegistry;
  unitOfWork: SqliteUnitOfWork;
  eventBus: InMemoryEventBus;
  deliverySink: SqliteDeliverySink;
  outboxWorker: OutboxWorker;
  sessionRepo: SqliteSessionRepository;
  contextItemRepo: SqliteContextItemRepository;
  consumerOffsetRepo: SqliteConsumerOffsetRepository;
  sessionTurnRepo: SessionTurnRepository;
  internalMessageProvenanceRepo: InternalMessageProvenanceRepository;
  taskRunsRepo: TaskRunsRepository;
  deferredReplacementRepo: SqliteDeferredReplacementRepository;
  services: {
    runService: RunService;
    contractService: ContractService;
    assignmentService: AssignmentService;
    verificationService: VerificationService;
    completionService: CompletionService;
    replayService: ReplayService;
    eventService: EventService;
    healthService: HealthService;
    runRepo: IRunRepository;
    childExecutionLifecycleService: ChildExecutionLifecycleService;
    progressObservationService: ProgressObservationService;
    orchestrationSnapshotService: OrchestrationSnapshotService;
    transitionEngine: RunTransitionEngine;
    completionPolicy: CompletionPolicy;
    continuationPolicy: ContinuationPolicy;
    continuationDispatcher: ContinuationDispatcher;
  };
  router: ReturnType<typeof createRouterWithControllers>;
  childExecutionLifecycleService: ChildExecutionLifecycleService;
  progressObservationService: ProgressObservationService;
  orchestrationSnapshotService: OrchestrationSnapshotService;
  transitionEngine: RunTransitionEngine;
  completionPolicy: CompletionPolicy;
  continuationPolicy: ContinuationPolicy;
  continuationDispatcher: ContinuationDispatcher;
  routingDecisionRepository: SqliteRoutingDecisionRepository;
  routingRevisionService: RoutingRevisionService;
  /** Advisory repository intelligence; it has no execution, verification, or completion authority. */
  repoMaster?: RepoMaster;
  metrics: OrchestrationMetrics;
  executionRepository: SqliteExecutionRepository;
  executionScheduler: ExecutionScheduler;
  worktreeExecutionService?: WorktreeExecutionService;
  performanceRepository: SqlitePerformanceRepository;
  authoritativeRouting: AuthoritativeRoutingService;
  worktreeManager?: GitWorktreeManager;
  integrationService?: ControlledIntegrationService;
  tokenRuntime?: TokenBudgetRuntime;
  agentExecutor?: IsolatedWorkstreamExecutor;
  assignmentBindingCoordinator: AssignmentBindingCoordinator;
  faultHook?: CommandFaultHook;
  commands: {
    registry: CommandRegistry;
    executor: DurableCommandExecutor;
  };
}

// ── SQLite-backed production repository implementations ────────────────

export class SqliteRunRepository implements IRunRepository {
  constructor(
    private readonly adapter: SqliteTaskRunAdapter,
    private readonly db: Database,
    private readonly tx: TransactionManager,
  ) {}

  async create(run: Run): Promise<Run> {
    return this.tx.write(() => {
      const contractId = run.contractId ?? "contract-default";
      this.db.query(
        `INSERT OR IGNORE INTO contract_families (family_id, name, description, created_by, created_at)
         VALUES ('family-default', 'Default Family', 'Default contract family', 'system', datetime('now'))`,
      ).run();
      this.db.query(
        `INSERT OR IGNORE INTO task_contracts (contract_id, family_id, version, title, description, repo_url, repo_sha, created_by, created_at)
         VALUES (?, 'family-default', 1, 'Default Contract', 'Default contract description', 'https://github.com/heidi-dang/FlowDeck', '0000000000000000000000000000000000000000', 'system', datetime('now'))`,
      ).run(contractId);
      this.db.query(
        `INSERT INTO task_runs (run_id, contract_id, strategy, state, aggregate_version, baseline_sha, repo_branch, created_at, created_ts)
         VALUES (?, ?, ?, ?, 1, ?, ?, datetime('now'), strftime('%s','now'))`,
      ).run(run.id, contractId, run.runType, mapRunStatusToTaskRunState(run.status), "0000000000000000000000000000000000000000", "main");
      if (run.correlationId) {
        this.db.query(
          `INSERT INTO execution_metadata (id, run_id, key, value, created_at)
           VALUES (?, ?, ?, ?, datetime('now'))`
        ).run("run_correlation:" + run.correlationId, run.id, "run_correlation:" + run.correlationId, run.id);
      }
      return run;
    });
  }

  async update(id: string, input: UpdateRunInput): Promise<Run | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    return this.tx.write(() => {
      if (input.status !== undefined) {
        const persistedState = mapRunStatusToTaskRunState(input.status);
        if (persistedState === "completed") {
          throw OrchestrationError.fromCode(ErrorCodes.COMPLETION_POLICY_REQUIRED, {
            message: "Only CompletionPolicy may transition a Run to completed.",
          });
        }
        this.db.query(
          "UPDATE task_runs SET state = ?, aggregate_version = aggregate_version + 1 WHERE run_id = ?",
        ).run(persistedState, id);
      }
      // Re-read the durable row to return accurate state
      const row = this.db.query("SELECT * FROM task_runs WHERE run_id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.run_id as string,
        status: mapTaskRunStateToRunStatus(row.state as string),
        runType: (row.strategy as string) ?? "simple",
        correlationId: row.run_id as string,
        contractId: row.contract_id as string,
        aggregateId: row.run_id as string,
        createdAt: (row.created_at as string) ?? new Date().toISOString(),
        updatedAt: (row.created_at as string) ?? new Date().toISOString(),
        startedAt: (row.started_at as string) ?? undefined,
        completedAt: (row.completed_at as string) ?? undefined,
      };
    });
  }

  async findById(id: string): Promise<Run | null> {
    const row = this.db.query("SELECT * FROM task_runs WHERE run_id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (!isValidPersistedPhase(row.state as string)) {
      throw new Error(`INVALID_PERSISTED_PHASE: "${row.state}" is not a valid persisted orchestration phase.`);
    }
    const metaRow = this.db.query(
      "SELECT key FROM execution_metadata WHERE run_id = ? AND key LIKE 'run_correlation:%' LIMIT 1"
    ).get(id) as { key: string } | undefined;
    const correlationId = metaRow ? metaRow.key.slice("run_correlation:".length) : (row.run_id as string);
    return {
      id: row.run_id as string,
      status: mapTaskRunStateToRunStatus(row.state as string),
      runType: (row.strategy as string) ?? "simple",
      correlationId,
      contractId: row.contract_id as string,
      aggregateId: row.run_id as string,
      createdAt: (row.created_at as string) ?? new Date().toISOString(),
      updatedAt: (row.created_at as string) ?? new Date().toISOString(),
      startedAt: (row.started_at as string) ?? undefined,
      completedAt: (row.completed_at as string) ?? undefined,
    };
  }

  async findByCorrelationId(correlationId: string): Promise<Run | null> {
    const metaRow = this.db.query(
      "SELECT run_id FROM execution_metadata WHERE key = ? LIMIT 1"
    ).get("run_correlation:" + correlationId) as { run_id: string } | undefined;
    if (metaRow?.run_id) {
      return this.findById(metaRow.run_id);
    }
    const eventRow = this.db.query(
      "SELECT aggregate_id FROM events WHERE correlation_id = ? ORDER BY global_sequence ASC LIMIT 1"
    ).get(correlationId) as { aggregate_id: string } | undefined;
    if (eventRow?.aggregate_id) {
      return this.findById(eventRow.aggregate_id);
    }
    // Fallback: check if correlationId matches a run_id directly
    return this.findById(correlationId);
  }

  async findMany(filter: RunFilter, pagination: PagePaginationRequest): Promise<PaginatedResult<Run>> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      // Map public RunStatus to persisted OrchestrationPhase - throws on invalid status
      const persistedPhase = mapRunStatusToTaskRunState(filter.status);
      conditions.push("state = ?");
      params.push(persistedPhase);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = pagination.limit ?? 20;
    const offset = ((pagination.page ?? 1) - 1) * limit;
    const countRow = this.db.query(`SELECT COUNT(*) AS c FROM task_runs ${where}`).get(...params) as { c: number };
    const rows = this.db.query(`SELECT * FROM task_runs ${where} ORDER BY created_ts DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Record<string, unknown>[];
    return {
      items: rows.map(r => {
        if (!isValidPersistedPhase(r.state as string)) {
          throw new Error(`INVALID_PERSISTED_PHASE: "${r.state}" is not a valid persisted orchestration phase.`);
        }
        return {
          id: r.run_id,
          status: mapTaskRunStateToRunStatus(r.state as string),
          runType: r.strategy,
          correlationId: r.run_id,
          contractId: r.contract_id,
          aggregateId: r.run_id,
          createdAt: r.created_at,
          updatedAt: r.created_at,
        } as unknown as Run;
      }),
      total: countRow.c,
      page: pagination.page ?? 1,
      limit,
    };
  }

  async count(filter: RunFilter): Promise<number> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      // Map public RunStatus to persisted OrchestrationPhase - throws on invalid status
      const persistedPhase = mapRunStatusToTaskRunState(filter.status);
      conditions.push("state = ?");
      params.push(persistedPhase);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db.query(`SELECT COUNT(*) AS c FROM task_runs ${where}`).get(...params) as { c: number };
    return row.c;
  }
}

export class SqliteContractRepo implements IContractRepository {
  constructor(
    private readonly adapter: SqliteContractAdapter,
    private readonly db: Database,
    private readonly tx: TransactionManager,
  ) {}

  async create(contract: Contract): Promise<Contract> {
    return this.tx.write(() => {
      this.db.query(
        `INSERT OR IGNORE INTO contract_families (family_id, name, description, created_by, created_at)
         VALUES ('family-default', 'Default Family', 'Default contract family', 'system', datetime('now'))`,
      ).run();
      this.db.query(
        `INSERT INTO task_contracts (contract_id, family_id, version, title, description, repo_url, repo_sha, created_by, created_at)
         VALUES (?, 'family-default', 1, ?, ?, 'https://github.com/heidi-dang/FlowDeck', '0000000000000000000000000000000000000000', 'system', datetime('now'))`,
      ).run(contract.id, contract.name, contract.description ?? "");
      return contract;
    });
  }

  async update(id: string, input: Partial<Contract>): Promise<Contract | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    return this.tx.write(() => {
      const sets: string[] = [];
      const values: (string | number)[] = [];
      if (input.name !== undefined) {
        sets.push("title = ?");
        values.push(input.name);
      }
      if (input.description !== undefined) {
        sets.push("description = ?");
        values.push(input.description);
      }
      if (sets.length === 0) {
        // No fields to update, return existing as-is
        return existing;
      }
      values.push(id);
      const sql = `UPDATE task_contracts SET ${sets.join(", ")} WHERE contract_id = ?`;
      const result = this.db.query(sql).run(...values);
      if (result.changes === 0) {
        // Contract no longer exists after update attempt
        return null;
      }
      // Re-read the durable row
      const row = this.db.query("SELECT * FROM task_contracts WHERE contract_id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.contract_id as string,
        name: (row.title as string) ?? row.contract_id as string,
        status: "active" as Contract["status"],
        correlationId: id,
        createdAt: (row.created_at as string) ?? new Date().toISOString(),
        updatedAt: (row.created_at as string) ?? new Date().toISOString(),
      };
    });
  }

  async findById(id: string): Promise<Contract | null> {
    const row = this.db.query("SELECT * FROM task_contracts WHERE contract_id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.contract_id as string,
      name: (row.title as string) ?? row.contract_id as string,
      status: "active" as Contract["status"],
      correlationId: id,
      createdAt: (row.created_at as string) ?? new Date().toISOString(),
      updatedAt: (row.created_at as string) ?? new Date().toISOString(),
    };
  }

  async findMany(_filter: Partial<Contract>, pagination: PagePaginationRequest): Promise<PaginatedResult<Contract>> {
    const limit = pagination.limit ?? 20;
    const offset = ((pagination.page ?? 1) - 1) * limit;
    const countRow = this.db.query("SELECT COUNT(*) AS c FROM task_contracts").get() as { c: number };
    const rows = this.db.query("SELECT * FROM task_contracts ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) as Record<string, unknown>[];
    return { items: rows.map(r => ({ id: r.contract_id, name: r.title, status: "active", correlationId: r.contract_id, createdAt: r.created_at, updatedAt: r.created_at }) as unknown as Contract), total: countRow.c, page: pagination.page ?? 1, limit };
  }

  async count(): Promise<number> {
    const row = this.db.query("SELECT COUNT(*) AS c FROM task_contracts").get() as { c: number };
    return row.c;
  }
}

export class SqliteAssignmentRepo implements IAssignmentRepository {
  constructor(
    private readonly db: Database,
    private readonly tx: TransactionManager,
  ) {}

  async create(a: Assignment): Promise<Assignment> {
    return this.tx.write(() => {
      this.db.query(
        "INSERT INTO assignments (id, run_id, agent_id, description, status, created_by, created_at) VALUES (?, ?, ?, ?, 'pending', 'system', datetime('now'))",
      ).run(a.id, a.runId, a.agentId, a.role ?? "");
      return a;
    });
  }

  async update(id: string, input: Partial<Assignment>): Promise<Assignment | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    // Validate all fields before entering transaction
    if (input.result !== undefined) {
      throw OrchestrationError.fromCode(ErrorCodes.ASSIGNMENT_RESULT_PERSISTENCE_NOT_CONFIGURED, {
        message: "Assignment result persistence requires a schema migration. The current schema has no column for storing assignment results.",
        details: { assignmentId: id },
      });
    }
    if (input.metadata !== undefined) {
      throw OrchestrationError.fromCode(ErrorCodes.ASSIGNMENT_METADATA_PERSISTENCE_NOT_CONFIGURED, {
        message: "Assignment metadata persistence requires a schema migration. The current schema has no column for storing assignment metadata.",
        details: { assignmentId: id },
      });
    }
    return this.tx.write(() => {
      const sets: string[] = [];
      const values: (string | number)[] = [];
      // Map input fields to assignments table columns
      if (input.status !== undefined) {
        sets.push("status = ?");
        // The frozen schema stores the durable execution states pending/running/
        // completed/failed/skipped/cancelled; the API's assigned/in_progress
        // aliases project onto those canonical states.
        values.push(input.status === "assigned" ? "pending" : input.status === "in_progress" ? "running" : input.status);
      }
      if (input.agentId !== undefined) {
        sets.push("agent_id = ?");
        values.push(input.agentId);
      }
      if (input.role !== undefined) {
        sets.push("description = ?");
        values.push(input.role);
      }
      if (sets.length === 0) {
        // No fields to update, return existing as-is
        return existing;
      }
      values.push(id);
      const sql = `UPDATE assignments SET ${sets.join(", ")} WHERE id = ?`;
      const result = this.db.query(sql).run(...values);
      if (result.changes === 0) {
        // Assignment no longer exists after update attempt
        return null;
      }
      // Re-read the durable row
      const row = this.db.query("SELECT * FROM assignments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as string,
        runId: row.run_id as string,
        agentId: row.agent_id as string,
        role: row.description as string,
        status: row.status as Assignment["status"],
        correlationId: row.run_id as string,
        createdAt: row.created_at as string,
        updatedAt: row.created_at as string,
      };
    });
  }

  async findById(id: string): Promise<Assignment | null> {
    const row = this.db.query("SELECT * FROM assignments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: row.id as string, runId: row.run_id as string, agentId: row.agent_id as string, role: row.description as string, status: row.status as Assignment["status"], correlationId: row.run_id as string, createdAt: row.created_at as string, updatedAt: row.created_at as string };
  }

  async findMany(_filter: Partial<Assignment>, pagination: PagePaginationRequest): Promise<PaginatedResult<Assignment>> {
    const limit = pagination.limit ?? 20;
    const offset = ((pagination.page ?? 1) - 1) * limit;
    const countRow = this.db.query("SELECT COUNT(*) AS c FROM assignments").get() as { c: number };
    const rows = this.db.query("SELECT * FROM assignments ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) as Record<string, unknown>[];
    return { items: rows.map(r => ({ id: r.id, runId: r.run_id, agentId: r.agent_id, role: r.description, status: r.status, correlationId: r.run_id, createdAt: r.created_at, updatedAt: r.created_at }) as unknown as Assignment), total: countRow.c, page: pagination.page ?? 1, limit };
  }

  async count(): Promise<number> {
    const row = this.db.query("SELECT COUNT(*) AS c FROM assignments").get() as { c: number };
    return row.c;
  }
}

export class SqliteCompletionRepo implements ICompletionRepository {
  constructor(
    private readonly adapter: SqliteCompletionRepoAdapter,
    private readonly db: Database,
    private readonly tx: TransactionManager,
  ) {}

  async create(c: Completion): Promise<Completion> {
    return this.tx.write(() => {
      this.db.query(
        "INSERT INTO completion_decisions (id, run_id, decision, sha, checks, idempotency_key, decided_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
      ).run(c.id, c.runId, c.status === "completed" ? "pass" : "fail", "", JSON.stringify(c.summary ?? ""), c.correlationId);
      return c;
    });
  }

  async update(id: string, _input: Partial<Completion>): Promise<Completion | null> {
    // completion_decisions is append-only by design:
    // - decision column only accepts 'pass' or 'fail' (CHECK constraint)
    // - no mutable status, summary, outcome, or metadata columns exist
    // - the record represents a historical decision point, not a mutable state
    throw OrchestrationError.fromCode(ErrorCodes.COMPLETION_DECISION_IMMUTABLE, {
      message: "Completion decisions are immutable. The completion_decisions table records historical decisions that cannot be modified.",
      details: { completionId: id },
    });
  }

  async findById(id: string): Promise<Completion | null> {
    const row = this.db.query("SELECT * FROM completion_decisions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: row.id as string, runId: row.run_id as string, status: row.decision as unknown as Completion["status"], summary: (row.checks as string) ?? "", correlationId: row.idempotency_key as string, createdAt: row.decided_at as string, updatedAt: row.decided_at as string };
  }

  async findByRunId(runId: string): Promise<Completion | null> {
    const row = this.db.query("SELECT * FROM completion_decisions WHERE run_id = ? ORDER BY decided_at DESC LIMIT 1").get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: row.id as string, runId: row.run_id as string, status: row.decision as unknown as Completion["status"], summary: (row.checks as string) ?? "", correlationId: row.idempotency_key as string, createdAt: row.decided_at as string, updatedAt: row.decided_at as string };
  }
}

class SqliteVerificationRepo implements IVerificationRepository {
  constructor(
    private readonly adapter: SqliteVerificationRepoAdapter,
    private readonly db: Database,
    private readonly tx: TransactionManager,
  ) {}

  private toVerification(row: Record<string, unknown>): VerificationResult {
    const isLiveAuthority = row.state_version !== null && row.state_version !== undefined
      || row.verification_type === "live_orchestration";
    const parseJsonArray = (value: unknown, field: string): string[] => {
      if (typeof value !== "string" || value.length === 0) {
        if (isLiveAuthority) throw new Error(`CORRUPT_LIVE_VERIFICATION_ROW:${field}`);
        return [];
      }
      try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string" || item.length === 0)) {
          if (isLiveAuthority) throw new Error(`CORRUPT_LIVE_VERIFICATION_ROW:${field}`);
          return [];
        }
        return [...new Set(parsed)].sort();
      } catch (error) {
        if (isLiveAuthority) {
          if (error instanceof Error && error.message.startsWith("CORRUPT_LIVE_VERIFICATION_ROW:")) throw error;
          throw new Error(`CORRUPT_LIVE_VERIFICATION_ROW:${field}`);
        }
        return [];
      }
    };

    const status = row.status;
    const stateVersion = row.state_version;
    const stateFingerprint = row.state_fingerprint;
    const targetSha = row.target_sha;
    if (isLiveAuthority) {
      if (typeof status !== "string" || !["pending", "in_progress", "passed", "failed", "skipped", "error"].includes(status)) {
        throw new Error("CORRUPT_LIVE_VERIFICATION_ROW:status");
      }
      if (!Number.isSafeInteger(stateVersion) || (stateVersion as number) < 1) {
        throw new Error("CORRUPT_LIVE_VERIFICATION_ROW:state_version");
      }
      if (typeof stateFingerprint !== "string" || !/^[a-f0-9]{32}$/i.test(stateFingerprint)) {
        throw new Error("CORRUPT_LIVE_VERIFICATION_ROW:state_fingerprint");
      }
      if (typeof targetSha !== "string" || !/^[a-f0-9]{40}$/i.test(targetSha)) {
        throw new Error("CORRUPT_LIVE_VERIFICATION_ROW:target_sha");
      }
      if (row.is_stale !== 0 && row.is_stale !== 1) {
        throw new Error("CORRUPT_LIVE_VERIFICATION_ROW:is_stale");
      }
    }

    return {
      id: row.id as string,
      runId: row.run_id as string,
      assignmentId: (row.assignment_id as string | null) ?? undefined,
      checkType: row.verification_type as string,
      status: status as VerificationResult["status"],
      correlationId: (row.correlation_id as string | null) ?? row.run_id as string,
      causationId: (row.causation_id as string | null) ?? undefined,
      result: (row.output_summary as string | null) ?? undefined,
      error: (row.error_output as string | null) ?? undefined,
      evidenceIds: parseJsonArray(row.evidence_json, "evidence_json"),
      failureReasons: parseJsonArray(row.failure_reasons, "failure_reasons"),
      stateVersion: (stateVersion as number | null) ?? undefined,
      stateFingerprint: (stateFingerprint as string | null) ?? undefined,
      targetSha: targetSha as string,
      isStale: row.is_stale === 1,
      createdAt: row.started_at as string,
      updatedAt: (row.updated_at as string | null) ?? (row.completed_at as string | null) ?? row.started_at as string,
    };
  }

  async create(v: VerificationResult): Promise<VerificationResult> {
    return this.tx.write(() => {
      this.db.query(
        `INSERT OR IGNORE INTO verification_results (
          id, run_id, verification_type, status, target_sha, output_summary, error_output,
          is_stale, started_at, state_version, state_fingerprint, evidence_json,
          failure_reasons, correlation_id, causation_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        v.id,
        v.runId,
        v.checkType ?? "unknown",
        v.status ?? "pending",
        v.targetSha ?? "0000000000000000000000000000000000000000",
        v.result ?? null,
        v.error ?? null,
        v.isStale ? 1 : 0,
        v.stateVersion ?? null,
        v.stateFingerprint ?? null,
        JSON.stringify(v.evidenceIds ?? []),
        JSON.stringify(v.failureReasons ?? []),
        v.correlationId,
        v.causationId ?? null,
      );

      const row = v.stateVersion !== undefined
        ? this.db.query(
          "SELECT * FROM verification_results WHERE run_id = ? AND state_version = ? AND state_fingerprint = ? AND verification_type = ?",
        ).get(v.runId, v.stateVersion, v.stateFingerprint ?? "", v.checkType) as Record<string, unknown> | undefined
        : this.db.query("SELECT * FROM verification_results WHERE id = ?").get(v.id) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Verification persistence failed for ${v.id}`);
      return this.toVerification(row);
    });
  }

  async update(id: string, input: Partial<VerificationResult>): Promise<VerificationResult | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    return this.tx.write(() => {
      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      if (input.status !== undefined) {
        sets.push("status = ?");
        values.push(input.status);
      }
      if (input.result !== undefined) {
        sets.push("output_summary = ?");
        values.push(input.result);
      }
      if (input.error !== undefined) {
        sets.push("error_output = ?");
        values.push(input.error);
      }
      if (input.evidenceIds !== undefined) {
        sets.push("evidence_json = ?");
        values.push(JSON.stringify(input.evidenceIds));
      }
      if (input.failureReasons !== undefined) {
        sets.push("failure_reasons = ?");
        values.push(JSON.stringify(input.failureReasons));
      }
      if (input.isStale !== undefined) {
        sets.push("is_stale = ?");
        values.push(input.isStale ? 1 : 0);
      }
      if (input.stateFingerprint !== undefined) {
        sets.push("state_fingerprint = ?");
        values.push(input.stateFingerprint);
      }
      if (input.targetSha !== undefined) {
        sets.push("target_sha = ?");
        values.push(input.targetSha);
      }
      if (sets.length === 0) return existing;
      if (input.status === "passed" || input.status === "failed" || input.status === "skipped") {
        sets.push("completed_at = datetime('now')");
      }
      sets.push("updated_at = datetime('now')");
      values.push(id);
      const result = this.db.query(`UPDATE verification_results SET ${sets.join(", ")} WHERE id = ?`).run(...values);
      if (result.changes === 0) return null;
      const row = this.db.query("SELECT * FROM verification_results WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? this.toVerification(row) : null;
    });
  }

  async findById(id: string): Promise<VerificationResult | null> {
    const row = this.db.query("SELECT * FROM verification_results WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toVerification(row) : null;
  }

  async findMany(filter: Partial<VerificationResult>, pagination: PagePaginationRequest): Promise<PaginatedResult<VerificationResult>> {
    const limit = pagination.limit ?? 20;
    const offset = ((pagination.page ?? 1) - 1) * limit;
    const where = filter.runId ? " WHERE run_id = ?" : "";
    const args = filter.runId ? [filter.runId] : [];
    const countRow = this.db.query(`SELECT COUNT(*) AS c FROM verification_results${where}`).get(...args) as { c: number };
    const rows = this.db.query(`SELECT * FROM verification_results${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[];
    return { items: rows.map(row => this.toVerification(row)), total: countRow.c, page: pagination.page ?? 1, limit };
  }

  async count(): Promise<number> {
    const row = this.db.query("SELECT COUNT(*) AS c FROM verification_results").get() as { c: number };
    return row.c;
  }

  async findByRunId(runId: string): Promise<VerificationResult[]> {
    const rows = this.db.query("SELECT * FROM verification_results WHERE run_id = ? ORDER BY started_at DESC").all(runId) as Record<string, unknown>[];
    return rows.map(row => this.toVerification(row));
  }

  async findByLiveIdentity(runId: string, stateVersion: number, stateFingerprint: string, checkType: string): Promise<VerificationResult | null> {
    const row = this.db.query(
      "SELECT * FROM verification_results WHERE run_id = ? AND state_version = ? AND state_fingerprint = ? AND verification_type = ?",
    ).get(runId, stateVersion, stateFingerprint, checkType) as Record<string, unknown> | undefined;
    return row ? this.toVerification(row) : null;
  }
}

class SqliteEventRepo implements IEventRepository {
  constructor(
    private readonly adapter: SqliteEventAppenderAdapter,
    private readonly db: Database,
    private readonly tx: TransactionManager,
  ) {}

  async store(e: OrchestrationEvent): Promise<OrchestrationEvent> {
    return this.tx.write(() => {
      const eventData = JSON.stringify(e.data ?? {});
      const eventMeta = JSON.stringify(e.metadata ?? {});
      this.db.query(
        `INSERT INTO events (event_id, event_type, event_version, causation_id, correlation_id, aggregate_type, aggregate_id, aggregate_version, timestamp, data, metadata, created_ts)
         VALUES (?, ?, 1, ?, ?, 'orchestration', ?, ?, datetime('now'), ?, ?, strftime('%s','now'))`,
      ).run(e.id, e.type, e.causationId ?? null, e.correlationId, e.aggregateId ?? "", e.aggregateVersion ?? 1, eventData, eventMeta);
      return e;
    });
  }

  async findById(id: string): Promise<OrchestrationEvent | null> {
    const row = this.db.query("SELECT * FROM events WHERE event_id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.event_id as string,
      type: row.event_type as string,
      eventVersion: (row.event_version as number) ?? 1,
      timestamp: (row.timestamp as string) ?? new Date().toISOString(),
      correlationId: (row.correlation_id as string) ?? "",
      causationId: (row.causation_id as string) ?? undefined,
      aggregateId: row.aggregate_id as string,
      aggregateVersion: row.aggregate_version as number,
      data: safeParseJSON(row.data as string),
      metadata: safeParseJSON(row.metadata as string),
    };
  }

  async findMany(_filter: EventFilter | Partial<OrchestrationEvent>, pagination: PagePaginationRequest): Promise<PaginatedResult<OrchestrationEvent>> {
    const limit = pagination.limit ?? 20;
    const offset = ((pagination.page ?? 1) - 1) * limit;
    const countRow = this.db.query("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    const rows = this.db.query("SELECT * FROM events ORDER BY created_ts DESC LIMIT ? OFFSET ?").all(limit, offset) as Record<string, unknown>[];
    return { items: rows.map(r => ({ id: r.event_id, type: r.event_type, eventVersion: r.event_version ?? 1, timestamp: r.timestamp ?? "", correlationId: r.correlation_id ?? "", aggregateId: r.aggregate_id, aggregateVersion: r.aggregate_version, data: safeParseJSON(r.data as string), metadata: safeParseJSON(r.metadata as string) }) as unknown as OrchestrationEvent), total: countRow.c, page: pagination.page ?? 1, limit };
  }

  async count(): Promise<number> {
    const row = this.db.query("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    return row.c;
  }

  async findByRunId(runId: string): Promise<OrchestrationEvent[]> {
    const rows = this.db.query("SELECT * FROM events WHERE aggregate_id = ? ORDER BY created_ts DESC").all(runId) as Record<string, unknown>[];
    return rows.map(r => ({ id: r.event_id, type: r.event_type, eventVersion: r.event_version ?? 1, timestamp: r.timestamp ?? "", correlationId: r.correlation_id ?? "", aggregateId: r.aggregate_id, aggregateVersion: r.aggregate_version, data: safeParseJSON(r.data as string), metadata: safeParseJSON(r.metadata as string) }) as unknown as OrchestrationEvent);
  }
}

function safeParseJSON(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

// ── Production composition factory ─────────────────────────────────────

export function createProductionOrchestrationRuntime(db: Database, options: { repositoryPath?: string; worktreeRoot?: string; routingMode?: () => string; budgetState?: () => Record<string, unknown>; fdxHealth?: () => Record<string, unknown>; agentExecutor?: IsolatedWorkstreamExecutor; faultHook?: CommandFaultHook; repoMaster?: RepoMaster } = {}): ProductionOrchestrationRuntime {
  const executionRegistry = new ExecutionRegistry();
  const unitOfWork = new SqliteUnitOfWork(db);
  const txManager = createTransactionManager(db);
  const eventBus = new InMemoryEventBus();

  const taskRunAdapter = new SqliteTaskRunAdapter(db, txManager);
  const contractAdapter = new SqliteContractAdapter(db, txManager);

  const outboxRepo = new SqliteOutboxRepository(db, txManager);
  const eventAppender = new SqliteEventAppenderAdapter(db, txManager);
  const deliverySink = new SqliteDeliverySink(db, txManager);

  const runRepo = new SqliteRunRepository(taskRunAdapter, db, txManager);
  const contractRepo = new SqliteContractRepo(contractAdapter, db, txManager);
  const assignmentRepo = new SqliteAssignmentRepo(db, txManager);
  const assignmentBindingRepo = new SqliteAssignmentExecutionBindingRepository(db, txManager);
  const completionAdapter = new SqliteCompletionRepoAdapter(db, txManager);
  const completionRepo = new SqliteCompletionRepo(completionAdapter, db, txManager);
  const verificationAdapter = new SqliteVerificationRepoAdapter(db, txManager);
  const verificationRepo = new SqliteVerificationRepo(verificationAdapter, db, txManager);
  const replayRepo = new SqliteReplayRepository(db, txManager);
  const eventRepo = new SqliteEventRepo(eventAppender, db, txManager);
  const sessionRepo = new SqliteSessionRepository(db, txManager);
  const contextItemRepo = new SqliteContextItemRepository(db, txManager);
  const consumerOffsetRepo = new SqliteConsumerOffsetRepository(db, txManager);
  const sessionTurnRepo = new SessionTurnRepository(db, txManager);
  const internalMessageProvenanceRepo = new InternalMessageProvenanceRepository(db, txManager);
  const routingDecisionRepository = new SqliteRoutingDecisionRepository(db, txManager);
  const routingRevisionService = new RoutingRevisionService(routingDecisionRepository);
  const repoMaster = options.repoMaster ?? new RepoMaster(options.repositoryPath ?? process.cwd());
  const metrics = new OrchestrationMetrics();
  const executionRepository = new SqliteExecutionRepository(db, txManager, metrics);
  executionRepository.reconcileIntegratedAttempts();
  const executionScheduler = new ExecutionScheduler(executionRepository, metrics);
  const performanceRepository = new SqlitePerformanceRepository(db, txManager, metrics);
  const authoritativeRouting = new AuthoritativeRoutingService(executionRepository);
  const snapshotService = new RuntimeSnapshotService(executionRepository, performanceRepository, metrics, options.routingMode, options.budgetState, options.fdxHealth);
  const worktreeManager = options.repositoryPath && options.worktreeRoot ? new GitWorktreeManager(options.repositoryPath, options.worktreeRoot) : undefined;
  const integrationService = worktreeManager && options.repositoryPath ? new ControlledIntegrationService(executionRepository, worktreeManager, options.repositoryPath, metrics) : undefined;
  const worktreeExecutionService = worktreeManager ? new WorktreeExecutionService(executionRepository, executionScheduler, worktreeManager, integrationService, undefined, performanceRepository) : undefined;
  const tokenRuntime = TokenBudgetRuntime.fromConfig(undefined, { directory: options.repositoryPath });
  if (worktreeExecutionService) {
    worktreeExecutionService.setBudgetCoordinator({
      open: workstream => tokenRuntime.openWorkstreamBudget(workstream),
      redistribute: (workstream, amount, reason, sourceReservationId) => tokenRuntime.redistributeWorkstream(workstream, amount, reason, sourceReservationId),
    });
  }
  if (worktreeExecutionService) {
    authoritativeRouting.setDispatcher(worktreeExecutionService);
    // Reconcile running leases and in-flight work before this runtime can
    // dispatch anything new. Recovery is durable and idempotent; it does not
    // infer successful agent work that was not persisted.
    worktreeExecutionService.recoverAfterRestart();
  }

  const outboxWorker = new OutboxWorker(deliverySink, eventBus, { workerId: "orchestration-main", batchSize: 20, leaseSeconds: 60 });

  const transactionalRunWriter = new SqliteTransactionalRunWriter();

  const assignmentService = new AssignmentService(assignmentRepo, eventBus);
  const nativeChildRepo = new SqliteNativeChildExecutionRepository(db, txManager);
  const childExecutionLifecycleService = new ChildExecutionLifecycleService(db, assignmentService, sessionRepo, executionRegistry, eventBus, nativeChildRepo, txManager);
  const progressObservationService = new ProgressObservationService(db);
  const taskRunsRepo = new TaskRunsRepository(db, txManager);
  const deferredReplacementRepo = new SqliteDeferredReplacementRepository(db);
  const orchestrationSnapshotService = new OrchestrationSnapshotService(
    db,
    taskRunsRepo,
    routingDecisionRepository,
    assignmentRepo,
    nativeChildRepo,
    progressObservationService,
    sessionRepo,
    repoMaster
  );
  const transitionEngine = new RunTransitionEngine(
    db,
    taskRunsRepo,
    assignmentRepo,
    nativeChildRepo,
    progressObservationService,
    orchestrationSnapshotService,
    txManager
  );
  const completionPolicy = new CompletionPolicy(db, txManager, orchestrationSnapshotService, transitionEngine);
  transitionEngine.bindCompletionPolicy(completionPolicy);
  const continuationPolicy = new ContinuationPolicy();
  const continuationDispatcher = new ContinuationDispatcher(db);
  // Reconcile restart-surviving pending continuation dispatches into outcome_unknown
  continuationDispatcher.reconcilePendingDispatches();
  const runService = new RunService(runRepo, eventBus, executionRegistry, unitOfWork, transactionalRunWriter, db, childExecutionLifecycleService);
  // Reconcile restart-surviving deferred replacements
  deferredReplacementRepo.reconcileAfterRestart();
  const contractService = new ContractService(contractRepo, eventBus);
  const assignmentBindingCoordinator = new AssignmentBindingCoordinator({ assignmentService, bindingRepo: assignmentBindingRepo });
  const verificationService = new VerificationService(verificationRepo, eventBus);
  const completionService = new CompletionService(completionRepo, eventBus);
  const replayService = new ReplayService(replayRepo, eventBus, eventRepo);
  const eventService = new EventService(eventRepo, outboxRepo, eventBus);
  const healthService = new HealthService();
  healthService.registerChecker("db", new SqliteDbChecker(db));
  healthService.registerChecker("outbox_worker", new OutboxWorkerChecker(outboxWorker, deliverySink));
  healthService.registerChecker("replay_service", new ReplayServiceChecker(replayRepo));

  const services = {
    runService,
    contractService,
    assignmentService,
    verificationService,
    completionService,
    replayService,
    eventService,
    healthService,
    routingProjection: new RoutingProjection(routingDecisionRepository, runService),
    performanceProjection: new PerformanceProjection(performanceRepository),
    snapshotService,
    runRepo,
    childExecutionLifecycleService,
    progressObservationService,
    orchestrationSnapshotService,
    transitionEngine,
    completionPolicy,
    continuationPolicy,
    continuationDispatcher,
  };

  const router = createRouterWithControllers(services);
  const commands = createCoreCommandRuntime(db, txManager, {
    db, executionRegistry, unitOfWork, eventBus, deliverySink, outboxWorker,
    sessionRepo, contextItemRepo, consumerOffsetRepo, sessionTurnRepo, internalMessageProvenanceRepo, taskRunsRepo, deferredReplacementRepo, services, router,
    routingDecisionRepository, routingRevisionService, childExecutionLifecycleService, progressObservationService, orchestrationSnapshotService, transitionEngine, completionPolicy, continuationPolicy, continuationDispatcher, metrics, executionRepository, executionScheduler,
    worktreeExecutionService, performanceRepository, authoritativeRouting,
    worktreeManager, integrationService, agentExecutor: options.agentExecutor,
    assignmentBindingCoordinator, faultHook: options.faultHook,
  });

  return {
    db,
    executionRegistry,
    unitOfWork,
    eventBus,
    deliverySink,
    outboxWorker,
    sessionRepo,
    contextItemRepo,
    consumerOffsetRepo,
    sessionTurnRepo,
    internalMessageProvenanceRepo,
    taskRunsRepo,
    deferredReplacementRepo,
    services,
    router,
    routingDecisionRepository,
    routingRevisionService,
    repoMaster,
    childExecutionLifecycleService,
    progressObservationService,
    orchestrationSnapshotService,
    transitionEngine,
    completionPolicy,
    continuationPolicy,
    continuationDispatcher,
    metrics,
    executionRepository,
    executionScheduler,
    worktreeExecutionService,
    performanceRepository,
    authoritativeRouting,
    worktreeManager,
    integrationService,
    tokenRuntime,
    agentExecutor: options.agentExecutor,
    assignmentBindingCoordinator,
    faultHook: options.faultHook,
    commands,
  };
}
