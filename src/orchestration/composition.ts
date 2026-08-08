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

export interface ProductionOrchestrationRuntime {
  db: Database;
  executionRegistry: ExecutionRegistry;
  unitOfWork: SqliteUnitOfWork;
  eventBus: InMemoryEventBus;
  deliverySink: SqliteDeliverySink;
  outboxWorker: OutboxWorker;
  services: {
    runService: RunService;
    contractService: ContractService;
    assignmentService: AssignmentService;
    verificationService: VerificationService;
    completionService: CompletionService;
    replayService: ReplayService;
    eventService: EventService;
    healthService: HealthService;
  };
  router: ReturnType<typeof createRouterWithControllers>;
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
      return run;
    });
  }

  async update(id: string, input: UpdateRunInput): Promise<Run | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    return this.tx.write(() => {
      if (input.status !== undefined) {
        const persistedState = mapRunStatusToTaskRunState(input.status);
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
        values.push(input.status);
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

  async create(v: VerificationResult): Promise<VerificationResult> {
    return this.tx.write(() => {
      this.db.query(
        "INSERT INTO verification_results (id, run_id, verification_type, status, target_sha, started_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
      ).run(v.id, v.runId, v.checkType ?? "unknown", v.status ?? "pending", "0000000000000000000000000000000000000000");
      return v;
    });
  }

  async update(id: string, input: Partial<VerificationResult>): Promise<VerificationResult | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    return this.tx.write(() => {
      const sets: string[] = [];
      const values: (string | number)[] = [];
      // Map input fields to verification_results columns
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
      // completed_at and duration_ms would be set when status moves to terminal
      if (sets.length === 0) {
        // No fields to update, return existing as-is
        return existing;
      }
      // Add completed_at when moving to terminal status
      if (input.status === 'passed' || input.status === 'failed' || input.status === 'skipped') {
        sets.push("completed_at = datetime('now')");
      }
      values.push(id);
      const sql = `UPDATE verification_results SET ${sets.join(", ")} WHERE id = ?`;
      const result = this.db.query(sql).run(...values);
      if (result.changes === 0) {
        // Verification result no longer exists after update attempt
        return null;
      }
      // Re-read the durable row
      const row = this.db.query("SELECT * FROM verification_results WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as string,
        runId: row.run_id as string,
        status: row.status as VerificationResult["status"],
        checkType: row.verification_type as string,
        correlationId: row.run_id as string,
        createdAt: row.started_at as string,
        updatedAt: row.completed_at as string ?? row.started_at as string,
      };
    });
  }

  async findById(id: string): Promise<VerificationResult | null> {
    const row = this.db.query("SELECT * FROM verification_results WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: row.id as string, runId: row.run_id as string, status: row.status as VerificationResult["status"], checkType: row.verification_type as string, correlationId: row.run_id as string, createdAt: row.started_at as string, updatedAt: row.started_at as string };
  }

  async findMany(_filter: Partial<VerificationResult>, pagination: PagePaginationRequest): Promise<PaginatedResult<VerificationResult>> {
    const limit = pagination.limit ?? 20;
    const offset = ((pagination.page ?? 1) - 1) * limit;
    const countRow = this.db.query("SELECT COUNT(*) AS c FROM verification_results").get() as { c: number };
    const rows = this.db.query("SELECT * FROM verification_results ORDER BY started_at DESC LIMIT ? OFFSET ?").all(limit, offset) as Record<string, unknown>[];
    return { items: rows.map(r => ({ id: r.id, runId: r.run_id, status: r.status as VerificationResult["status"], checkType: r.verification_type, correlationId: r.run_id, createdAt: r.started_at }) as unknown as VerificationResult), total: countRow.c, page: pagination.page ?? 1, limit };
  }

  async count(): Promise<number> {
    const row = this.db.query("SELECT COUNT(*) AS c FROM verification_results").get() as { c: number };
    return row.c;
  }

  async findByRunId(runId: string): Promise<VerificationResult[]> {
    const rows = this.db.query("SELECT * FROM verification_results WHERE run_id = ? ORDER BY started_at DESC").all(runId) as Record<string, unknown>[];
    return rows.map(r => ({ id: r.id, runId: r.run_id, status: r.status as VerificationResult["status"], checkType: r.verification_type, correlationId: r.run_id, createdAt: r.started_at }) as unknown as VerificationResult);
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

export function createProductionOrchestrationRuntime(db: Database): ProductionOrchestrationRuntime {
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
  const completionAdapter = new SqliteCompletionRepoAdapter(db, txManager);
  const completionRepo = new SqliteCompletionRepo(completionAdapter, db, txManager);
  const verificationAdapter = new SqliteVerificationRepoAdapter(db, txManager);
  const verificationRepo = new SqliteVerificationRepo(verificationAdapter, db, txManager);
  const replayRepo = new SqliteReplayRepository(db, txManager);
  const eventRepo = new SqliteEventRepo(eventAppender, db, txManager);

  const outboxWorker = new OutboxWorker(deliverySink, eventBus, { workerId: "orchestration-main", batchSize: 20, leaseSeconds: 60 });

  const transactionalRunWriter = new SqliteTransactionalRunWriter();

  const runService = new RunService(runRepo, eventBus, executionRegistry, unitOfWork, transactionalRunWriter, db);
  const contractService = new ContractService(contractRepo, eventBus);
  const assignmentService = new AssignmentService(assignmentRepo, eventBus);
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
  };

  const router = createRouterWithControllers(services);

  return {
    db,
    executionRegistry,
    unitOfWork,
    eventBus,
    deliverySink,
    outboxWorker,
    services,
    router,
  };
}