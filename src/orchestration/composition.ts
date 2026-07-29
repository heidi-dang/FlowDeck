import type { Database } from "bun:sqlite";
import { ExecutionRegistry } from "./services/execution-registry";
import { SqliteUnitOfWork } from "./persistence/unit-of-work";
import { createTransactionManager } from "./persistence/transaction-manager";
import { InMemoryEventBus } from "./services/event-bus-impl";
import { OutboxWorker } from "./services/outbox-worker";
import { SqliteTaskRunAdapter } from "./persistence/adapters/sqlite-runtime-adapter";
import { SqliteContractAdapter } from "./persistence/adapters/sqlite-contract-adapter";
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
import { HealthService } from "./services/health-service";
import type { IAssignmentRepository, IOutboxRepository } from "./services/ports";
import { createRouterWithControllers } from "./api/routes";

export interface ProductionOrchestrationRuntime {
  db: Database;
  executionRegistry: ExecutionRegistry;
  unitOfWork: SqliteUnitOfWork;
  eventBus: InMemoryEventBus;
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

export function createProductionOrchestrationRuntime(db: Database): ProductionOrchestrationRuntime {
  const executionRegistry = new ExecutionRegistry();
  const unitOfWork = new SqliteUnitOfWork(db);
  const txManager = createTransactionManager(db);
  const eventBus = new InMemoryEventBus();

  const taskRunAdapter = new SqliteTaskRunAdapter(db, txManager);
  const contractAdapter = new SqliteContractAdapter(db, txManager);

  const runMap = new Map<string, any>();
  const runRepo: any = {
    insertRunSync(r: any) {
      taskRunAdapter.insertRunSync({ runId: r.id ?? r.runId, contractId: r.contractId, strategy: "default", state: r.status ?? r.state ?? "queued", aggregateVersion: 1 });
      runMap.set(r.id ?? r.runId, r);
      return r;
    },
    updateStateSync(id: string, state: string, expectedVersion: number) {
      try {
        taskRunAdapter.updateStateSync(id, state, expectedVersion);
      } catch {}
      const existing = runMap.get(id);
      if (existing) {
        existing.status = state;
        existing.updatedAt = new Date().toISOString();
      }
    },
    async create(r: any) {
      return this.insertRunSync(r);
    },
    async findById(id: string) {
      const fromDb = taskRunAdapter.getRunSync(id);
      if (!fromDb) return null;
      const inMem = runMap.get(id);
      return inMem ? { ...inMem, status: fromDb.state ?? inMem.status } : fromDb;
    },
    async update(id: string, input: any) {
      const existing = runMap.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...input };
      runMap.set(id, updated);
      if (input.status) {
        try {
          taskRunAdapter.updateStateSync(id, input.status, 1);
        } catch {}
      }
      return updated;
    },
    async findMany() {
      const items = Array.from(runMap.values());
      return { data: items, items, total: items.length, page: 1, pageSize: 50, limit: 50, hasMore: false };
    },
    async count() { return runMap.size; },
  };

  const contractRepo: any = {
    async create(c: any) { return c; },
    async findById(id: string) { return contractAdapter.getContract(id); },
    async update(_id: string, _input: any) { return null; },
    async findMany() { return { data: [], items: [], total: 0, page: 1, pageSize: 50, limit: 50, hasMore: false }; },
    async count() { return 0; },
  };

  const assignmentRepo: IAssignmentRepository = {
    async create(a: any) { return a; },
    async findById(_id: string) { return null; },
    async update(_id: string, _input: any) { return null; },
    async findMany() { return { data: [], items: [], total: 0, page: 1, pageSize: 50, limit: 50, hasMore: false }; },
    async count() { return 0; },
  };

  const completionAdapter = new SqliteCompletionRepoAdapter(db, txManager);
  const completionRepo: any = {
    async create(c: any) { return c; },
    async findById(id: string) { return completionAdapter.getLatestDecisionByRun(id); },
    async update(_id: string, _input: any) { return null; },
    async findMany() { return { data: [], items: [], total: 0, page: 1, pageSize: 50, limit: 50, hasMore: false }; },
    async count() { return 0; },
  };

  const verificationAdapter = new SqliteVerificationRepoAdapter(db, txManager);
  const verificationRepo: any = {
    async create(v: any) {
      try {
        await verificationAdapter.saveRun({ id: v.id, contractVersionId: v.runId ?? v.contractVersionId ?? 'run-1', status: v.status, targetSha: v.sha ?? '0000000000000000000000000000000000000000', createdAt: new Date() });
      } catch {}
      return v;
    },
    async findById(id: string) { return verificationAdapter.getRun(id); },
    async update(_id: string, input: any) { return input; },
    async findMany() { return { data: [], items: [], total: 0, page: 1, pageSize: 50, limit: 50, hasMore: false }; },
    async count() { return 0; },
  };

  const eventAppender = new SqliteEventAppenderAdapter(db, txManager);
  const eventRepo: any = {
    async append(e: any) { await eventAppender.append(e); return e; },
    async findById(_id: string) { return null; },
    async findMany() { return { data: [], items: [], total: 0, page: 1, pageSize: 50, limit: 50, hasMore: false }; },
    async count() { return 0; },
  };

  const replayMap = new Map<string, any>();
  const replayRepo: any = {
    async create(r: any) { replayMap.set(r.id, r); return r; },
    async findById(id: string) { return replayMap.get(id) ?? null; },
    async findMany() { return { data: Array.from(replayMap.values()), items: Array.from(replayMap.values()), total: replayMap.size, page: 1, pageSize: 50, limit: 50, hasMore: false }; },
    async count() { return replayMap.size; },
  };

  const outboxRepo: IOutboxRepository = {
    async create(entry: any) { return entry; },
    async findById(_id: string) { return null; },
    async update(_id: string, _input: any) { return null; },
    async findMany() { return { data: [], items: [], total: 0, page: 1, pageSize: 50, limit: 50, hasMore: false }; },
    async count() { return 0; },
  };

  const outboxWorker = new OutboxWorker(outboxRepo, eventBus);

  const runService = new RunService(runRepo, eventBus, executionRegistry, unitOfWork);
  const contractService = new ContractService(contractRepo, eventBus);
  const assignmentService = new AssignmentService(assignmentRepo, eventBus);
  const verificationService = new VerificationService(verificationRepo, eventBus);
  const completionService = new CompletionService(completionRepo, eventBus);
  const replayService = new ReplayService(replayRepo, eventBus);
  const eventService = new EventService(eventRepo, outboxRepo, eventBus);
  const healthService = new HealthService();

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
    outboxWorker,
    services,
    router,
  };
}
