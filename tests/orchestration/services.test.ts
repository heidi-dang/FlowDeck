import { describe, it, expect, beforeEach, vi } from "bun:test";
import { RunService } from "../../src/orchestration/services/run-service";
import { CommandDispatcher } from "../../src/orchestration/services/command-dispatcher";
import { QueryService } from "../../src/orchestration/services/query-service";
import { ContractService } from "../../src/orchestration/services/contract-service";
import { AssignmentService } from "../../src/orchestration/services/assignment-service";
import { VerificationService } from "../../src/orchestration/services/verification-service";
import { CompletionService } from "../../src/orchestration/services/completion-service";
import { ReplayService } from "../../src/orchestration/services/replay-service";
import { HealthService } from "../../src/orchestration/services/health-service";
import { EventService } from "../../src/orchestration/services/event-service";
import { InMemoryEventBus } from "../../src/orchestration/services/event-bus-impl";
import { OrchestrationError, ErrorCodes, RunStatus } from "../../src/orchestration/types";
import { SseManager } from "../../src/orchestration/streaming/sse-manager";
import { WebSocketManager } from "../../src/orchestration/streaming/websocket-manager";
import { EventSubscriptionManager } from "../../src/orchestration/streaming/event-subscription";
import { OrchestrationMetrics } from "../../src/orchestration/metrics";
import { Tracer } from "../../src/orchestration/tracing";
import { StructuredLogger, LogSeverity } from "../../src/orchestration/logging";
import type { IRunRepository, IContractRepository, IAssignmentRepository, IVerificationRepository, ICompletionRepository, IReplayRepository, IEventRepository, IOutboxRepository, IIdempotencyStore, IAuthorizationService, PaginatedResult } from "../../src/orchestration/services/ports";
import { ExecutionRegistry } from "../../src/orchestration/services/execution-registry";
import type { UnitOfWork } from "../../src/orchestration/persistence/unit-of-work";
import type { TransactionalRunWriter } from "../../src/orchestration/persistence/transactional-run-writer";
import type { Database } from "bun:sqlite";
import type { PagePaginationRequest } from "../../src/orchestration/types/pagination";
import type { Run, UpdateRunInput, Contract, Assignment, OrchestrationEvent, OutboxEntry } from "../../src/orchestration/types";
import { EVENT_VERSION } from "../../src/orchestration/types/events";

// Local type aliases since the modules use them as interfaces
type ContractFilter = Partial<Contract>;
type VerificationFilter = { runId?: string; checkType?: string; status?: string; correlationId?: string };
type OutboxFilter = { status?: string; destination?: string; correlationId?: string };

// ── Mock repositories ────────────────────────────────────────────────────

function createMockRunRepo(): IRunRepository {
  const runs = new Map<string, Run>();
  return {
    create: vi.fn(async (run: Run) => { runs.set(run.id, run); return run; }),
    update: vi.fn(async (id: string, input: any) => {
      const existing = runs.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...input, updatedAt: new Date().toISOString() };
      runs.set(id, updated);
      return updated;
    }),
    findById: vi.fn(async (id: string) => runs.get(id) ?? null),
    findMany: vi.fn(async (_filter: any, _pagination: PagePaginationRequest): Promise<PaginatedResult<Run>> => {
      const items = Array.from(runs.values());
      return { items, total: items.length, page: 1, limit: 20 };
    }),
    count: vi.fn(async () => runs.size),
  };
}

function createMockContractRepo(): IContractRepository {
  const items = new Map<string, Contract>();
  return {
    create: vi.fn(async (c: Contract) => { items.set(c.id, c); return c; }),
    update: vi.fn(async (id: string, input: any) => {
      const e = items.get(id); if (!e) return null;
      const u = { ...e, ...input, updatedAt: new Date().toISOString() }; items.set(id, u); return u;
    }),
    findById: vi.fn(async (id: string) => items.get(id) ?? null),
    findMany: vi.fn(async (_: ContractFilter, __: PagePaginationRequest) => ({ items: Array.from(items.values()), total: items.size, page: 1, limit: 20 })),
    count: vi.fn(async () => items.size),
  };
}

function createMockAssignmentRepo(): IAssignmentRepository {
  const items = new Map<string, Assignment>();
  return {
    create: vi.fn(async (a: Assignment) => { items.set(a.id, a); return a; }),
    update: vi.fn(async (id: string, input: any) => {
      const e = items.get(id); if (!e) return null;
      const u = { ...e, ...input, updatedAt: new Date().toISOString() }; items.set(id, u); return u;
    }),
    findById: vi.fn(async (id: string) => items.get(id) ?? null),
    findMany: vi.fn(async (_: any, __: PagePaginationRequest) => ({ items: Array.from(items.values()), total: items.size, page: 1, limit: 20 })),
    count: vi.fn(async () => items.size),
  };
}

function createMockVerificationRepo(): IVerificationRepository {
  const items = new Map<string, any>();
  return {
    create: vi.fn(async (v: any) => { items.set(v.id, v); return v; }),
    update: vi.fn(async (id: string, input: any) => {
      const e = items.get(id); if (!e) return null;
      const u = {...e, ...input, updatedAt: new Date().toISOString()}; items.set(id, u); return u;
    }),
    findById: vi.fn(async (id: string) => items.get(id) ?? null),
    findMany: vi.fn(async (_: VerificationFilter, __: PagePaginationRequest) => ({ items: Array.from(items.values()), total: items.size, page: 1, limit: 20 })),
    count: vi.fn(async () => items.size),
    findByRunId: vi.fn(async (runId: string) => Array.from(items.values()).filter((v: any) => v.runId === runId)),
  };
}

function createMockCompletionRepo(): ICompletionRepository {
  const items = new Map<string, any>();
  return {
    create: vi.fn(async (c: any) => { items.set(c.id, c); return c; }),
    update: vi.fn(async (id: string, input: any) => {
      const e = items.get(id); if (!e) return null;
      const u = {...e, ...input, updatedAt: new Date().toISOString()}; items.set(id, u); return u;
    }),
    findById: vi.fn(async (id: string) => items.get(id) ?? null),
    findByRunId: vi.fn(async (runId: string) => Array.from(items.values()).find((c: any) => c.runId === runId) ?? null),
  };
}

function createMockReplayRepo(): IReplayRepository {
  const items = new Map<string, any>();
  return {
    create: vi.fn(async (r: any) => { items.set(r.id, r); return r; }),
    findById: vi.fn(async (id: string) => items.get(id) ?? null),
    findMany: vi.fn(async (_: PagePaginationRequest) => ({ items: Array.from(items.values()), total: items.size, page: 1, limit: 20 })),
    count: vi.fn(async () => items.size),
  };
}

function createMockEventRepo(): IEventRepository {
  const items = new Map<string, OrchestrationEvent>();
  return {
    store: vi.fn(async (e: OrchestrationEvent) => { items.set(e.id, e); return e; }),
    findById: vi.fn(async (id: string) => items.get(id) ?? null),
    findMany: vi.fn(async (_: any, __: PagePaginationRequest) => ({ items: Array.from(items.values()), total: items.size, page: 1, limit: 20 })),
    count: vi.fn(async () => items.size),
    findByRunId: vi.fn(async (runId: string) => Array.from(items.values()).filter(e => e.runId === runId)),
  };
}

function createMockOutboxRepo(): IOutboxRepository {
  const items = new Map<string, OutboxEntry>();
  return {
    create: vi.fn(async (e: OutboxEntry) => { items.set(e.id, e); return e; }),
    update: vi.fn(async (id: string, input: any) => {
      const e = items.get(id); if (!e) return null;
      const u = {...e, ...input}; items.set(id, u); return u;
    }),
    findById: vi.fn(async (id: string) => items.get(id) ?? null),
    findMany: vi.fn(async (_: OutboxFilter, __: PagePaginationRequest) => ({ items: Array.from(items.values()), total: items.size, page: 1, limit: 20 })),
    findPending: vi.fn(async () => Array.from(items.values()).filter(e => e.status === "pending")),
    claimNextBatch: vi.fn(async (batchSize: number) => Array.from(items.values()).filter(e => e.status === "pending").slice(0, batchSize)),
    markDelivered: vi.fn(async (id: string) => { const e = items.get(id); if (e) { e.status = "delivered" as any; } }),
    markFailed: vi.fn(async (id: string, _attemptCount: number, _lastError: string) => { const e = items.get(id); if (e) { e.status = "failed" as any; } }),
    count: vi.fn(async (filter?: any) => {
      if (filter?.status) return Array.from(items.values()).filter(e => e.status === filter.status).length;
      return items.size;
    }),
  };
}

function createMockIdempotencyStore(): IIdempotencyStore {
  const processed = new Set<string>();
  const results = new Map<string, Record<string, unknown>>();
  return {
    isDuplicate: vi.fn(async (key: string) => processed.has(key)),
    markProcessed: vi.fn(async (key: string) => { processed.add(key); }),
    getResult: vi.fn(async (key: string) => results.get(key) ?? null),
  };
}

function createMockAuthService(): IAuthorizationService {
  return {
    authorize: vi.fn(async (_action: string, _resource: string, _context: any) => ({ allowed: true })),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("Orchestration Services", () => {
  let eventBus: InMemoryEventBus;
  let mockRunRepo: IRunRepository;
  let mockContractRepo: IContractRepository;
  let mockAssignmentRepo: IAssignmentRepository;
  let mockVerificationRepo: IVerificationRepository;
  let mockCompletionRepo: ICompletionRepository;
  let mockReplayRepo: IReplayRepository;
  let mockEventRepo: IEventRepository;
  let mockOutboxRepo: IOutboxRepository;
  let mockIdempotencyStore: IIdempotencyStore;
  let mockAuthService: IAuthorizationService;

  let runService: RunService;
  let contractService: ContractService;
  let assignmentService: AssignmentService;
  let verificationService: VerificationService;
  let _completionService: CompletionService;
  let _replayService: ReplayService;
  let eventService: EventService;
  let healthService: HealthService;
  let commandDispatcher: CommandDispatcher;
  let queryService: QueryService;

  let executionRegistry: ExecutionRegistry;
  let mockUnitOfWork: UnitOfWork;

  beforeEach(() => {
    eventBus = new InMemoryEventBus();
    executionRegistry = new ExecutionRegistry();
    mockUnitOfWork = {
      execute: vi.fn(async (fn: any) => fn({ tx: {} })),
    };
    mockRunRepo = createMockRunRepo();
    mockContractRepo = createMockContractRepo();
    mockAssignmentRepo = createMockAssignmentRepo();
    mockVerificationRepo = createMockVerificationRepo();
    mockCompletionRepo = createMockCompletionRepo();
    mockReplayRepo = createMockReplayRepo();
    mockEventRepo = createMockEventRepo();
    mockOutboxRepo = createMockOutboxRepo();
    mockIdempotencyStore = createMockIdempotencyStore();
    mockAuthService = createMockAuthService();

  const mockWriter: TransactionalRunWriter = {
    createRunWithEventAndOutbox: vi.fn((_tx: any, _db: any, run: Run) => { mockRunRepo.create(run); return run; }),
    updateRunState: vi.fn((_tx: any, _db: any, _id: string, input: UpdateRunInput, _event: any, _outbox: any) => {
      mockRunRepo.update(_id, input);
      return { id: _id, status: (input.status ?? 'queued') as Run['status'], runType: 'test', correlationId: _id, stage: input.stage, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as Run;
    }),
  };
  const mockDb = {} as Database;
        runService = new RunService(mockRunRepo, eventBus, executionRegistry, mockUnitOfWork, mockWriter, mockDb);
    contractService = new ContractService(mockContractRepo, eventBus);
    assignmentService = new AssignmentService(mockAssignmentRepo, eventBus);
    verificationService = new VerificationService(mockVerificationRepo, eventBus);
    _completionService = new CompletionService(mockCompletionRepo, eventBus);
    _replayService = new ReplayService(mockReplayRepo, eventBus);
    eventService = new EventService(mockEventRepo, mockOutboxRepo, eventBus);
    healthService = new HealthService("test");
    commandDispatcher = new CommandDispatcher(mockAuthService, mockIdempotencyStore, eventBus);
    queryService = new QueryService(mockRunRepo, mockContractRepo, mockAssignmentRepo, mockVerificationRepo, mockEventRepo, mockOutboxRepo);
  });

  // ── RunService ────────────────────────────────────────────────────────
  describe("RunService", () => {
    it("should create a run with pending status (QUEUED canonicalized to PENDING)", async () => {
      const run = await runService.createRun({
        runType: "test-run",
        correlationId: "corr-1",
      });
      expect(run.id).toBeDefined();
      expect(run.status).toBe(RunStatus.PENDING);
      expect(run.runType).toBe("test-run");
      expect(run.correlationId).toBe("corr-1");
    });

    it("should update a run and change status", async () => {
      const run = await runService.createRun({ runType: "test", correlationId: "c1" });
      const updated = await runService.updateRun(run.id, { status: RunStatus.RUNNING, stage: "running" });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe(RunStatus.RUNNING);
      expect(updated!.stage).toBe("running");
    });

    it("should throw RUN_NOT_FOUND for unknown run", async () => {
      await expect(runService.getRun("nonexistent")).rejects.toThrow(OrchestrationError);
      await expect(runService.getRun("nonexistent")).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    });

    it("should cancel a run", async () => {
      const run = await runService.createRun({ runType: "test", correlationId: "c1" });
      await runService.updateRun(run.id, { status: RunStatus.RUNNING });
      const cancelled = await runService.cancelRun(run.id, "test cancellation");
      expect(cancelled.status).toBe(RunStatus.CANCELLED);
    });

    it("should fail to cancel a completed run", async () => {
      const run = await runService.createRun({ runType: "test", correlationId: "c1" });
      await runService.updateRun(run.id, { status: RunStatus.COMPLETED });
      await expect(runService.cancelRun(run.id)).rejects.toThrow(OrchestrationError);
    });
  });

  // ── ContractService ──────────────────────────────────────────────────
  describe("ContractService", () => {
    it("should create and retrieve a contract", async () => {
      const contract = await contractService.createContract({
        name: "Test Contract",
        correlationId: "corr-1",
      });
      expect(contract.id).toBeDefined();
      expect(contract.status).toBe("active");
      expect(contract.name).toBe("Test Contract");

      const found = await contractService.getContract(contract.id);
      expect(found.id).toBe(contract.id);
    });

    it("should complete a contract", async () => {
      const c = await contractService.createContract({ name: "Test", correlationId: "c1" });
      const completed = await contractService.completeContract(c.id);
      expect(completed.status).toBe("completed");
    });
  });

  // ── AssignmentService ────────────────────────────────────────────────
  describe("AssignmentService", () => {
    it("should create an assignment", async () => {
      const a = await assignmentService.createAssignment({
        runId: "run-1", agentId: "agent-1", role: "developer",
        correlationId: "corr-1",
      });
      expect(a.id).toBeDefined();
      expect(a.status).toBe("pending");
      expect(a.role).toBe("developer");
    });
  });

  // ── VerificationService ──────────────────────────────────────────────
  describe("VerificationService", () => {
    it("should create a verification result", async () => {
      const v = await verificationService.createVerification({
        runId: "run-1", checkType: "contract-check", correlationId: "corr-1",
      });
      expect(v.id).toBeDefined();
      expect(v.status).toBe("pending");
    });
  });

  // ── CommandDispatcher ───────────────────────────────────────────────
  describe("CommandDispatcher", () => {
    it("should reject unknown command types", async () => {
      const result = await commandDispatcher.dispatch({
        type: "unknown.command", payload: {},
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    });

    it("should dispatch to registered handler", async () => {
      commandDispatcher.registerHandler("test.command", async () => ({ ok: true }));
      const result = await commandDispatcher.dispatch({
        type: "test.command", payload: {},
      });
      expect(result.success).toBe(true);
    });
  });

  // ── HealthService ───────────────────────────────────────────────────
  describe("HealthService", () => {
    it("should return healthy status with no checks registered", async () => {
      const health = await healthService.checkHealth();
      expect(health.status).toBe("healthy");
      expect(health.version).toBe("test");
    });

    it("should return alive liveness", async () => {
      const liveness = await healthService.checkLiveness();
      expect(liveness.status).toBe("alive");
      expect(liveness.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  // ── EventService ────────────────────────────────────────────────────
  describe("EventService", () => {
    it("should publish and store an event", async () => {
      const ev = await eventService.publishEvent({
        type: "run.started" as any,
        eventVersion: EVENT_VERSION,
        correlationId: "corr-1",
        causationId: undefined,
        aggregateId: undefined,
        aggregateVersion: undefined,
        sessionId: undefined,
        agentId: undefined,
        runId: "run-1",
        assignmentId: undefined,
        contractId: undefined,
        data: {},
        metadata: { source: "test" },
      });
      expect(ev.id).toBeDefined();
      expect(ev.type).toBe("run.started");
      expect(ev.eventVersion).toBe(EVENT_VERSION);
    });
  });

  // ── QueryService ────────────────────────────────────────────────────
  describe("QueryService", () => {
    it("should list runs with cursor pagination", async () => {
      await runService.createRun({ runType: "test", correlationId: "c1" });
      const result = await queryService.listRuns({}, { page: 1, limit: 20 });
      expect(result.items.length).toBe(1);
      expect(result).toHaveProperty("nextCursor");
      expect(result).toHaveProperty("hasMore");
    });
  });
});

// ── Streaming tests ──────────────────────────────────────────────────────

describe("Streaming", () => {
  describe("SSE Manager", () => {
    it("should add and remove clients", () => {
      const sse = new SseManager(5000);
      expect(sse.getClientCount()).toBe(0);

      const mockRes = { writeHead: vi.fn(), write: vi.fn(), on: vi.fn(), end: vi.fn() };
      sse.addClient("client-1", mockRes as any);
      expect(sse.getClientCount()).toBe(1);

      sse.removeClient("client-1");
      expect(sse.getClientCount()).toBe(0);
      sse.dispose();
    });

    it("should reject when max clients reached", () => {
      const sse = new SseManager(5000);
      // Fill to max
      const mockRes = { writeHead: vi.fn(), write: vi.fn(), on: vi.fn(), end: vi.fn() };
      for (let i = 0; i < 500; i++) {
        const res = { writeHead: vi.fn(), write: vi.fn(), on: vi.fn(), end: vi.fn() };
        sse.addClient(`client-${i}`, res as any);
      }
      // Next one should be rejected
      const result = sse.addClient("overflow", mockRes as any);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("max_clients_reached");
      sse.dispose();
    });

    it("should handle reconnect by replacing old connection", () => {
      const sse = new SseManager(5000);
      const oldRes = { writeHead: vi.fn(), write: vi.fn(), on: vi.fn(), end: vi.fn() };
      const newRes = { writeHead: vi.fn(), write: vi.fn(), on: vi.fn(), end: vi.fn() };

      sse.addClient("client-1", oldRes as any);
      expect(sse.getClientCount()).toBe(1);

      // Reconnect with same ID
      const result = sse.addClient("client-1", newRes as any);
      expect(result.accepted).toBe(true);
      expect(sse.getClientCount()).toBe(1);
      // Old connection should have been ended
      expect(oldRes.end).toHaveBeenCalled();
      sse.dispose();
    });
  });

  describe("WebSocket Manager", () => {
    it("should add clients and send connected message", () => {
      const ws = new WebSocketManager(5000);
      const sent: string[] = [];
      ws.addClient("client-1", (data: string) => { sent.push(data); }, () => {});
      expect(sent.length).toBe(1);
      expect(sent[0]).toContain("connected");
      ws.dispose();
    });
  });

  describe("Event Subscription Manager", () => {
    it("should deliver events to subscribers", async () => {
      const mgr = new EventSubscriptionManager();
      const received: string[] = [];

      mgr.subscribe({
        id: "sub-1",
        handler: async (event) => { received.push(event.type); },
      });

      await mgr.deliver({
        id: "ev-1", type: "run.started" as any,
        eventVersion: EVENT_VERSION, timestamp: new Date().toISOString(),
        correlationId: "c1", data: {}, metadata: {},
      });

      expect(received).toContain("run.started");
    });
  });
});

// ── Metrics tests ────────────────────────────────────────────────────────

describe("Metrics", () => {
  it("should track counters", () => {
    const metrics = new OrchestrationMetrics();
    expect(metrics.commandsDispatched.get()).toBe(0);
    metrics.commandsDispatched.inc();
    expect(metrics.commandsDispatched.get()).toBe(1);
    metrics.commandsDispatched.inc(5);
    expect(metrics.commandsDispatched.get()).toBe(6);
  });

  it("should track gauges", () => {
    const metrics = new OrchestrationMetrics();
    metrics.activeRuns.set(5);
    expect(metrics.activeRuns.get()).toBe(5);
    metrics.activeRuns.inc();
    expect(metrics.activeRuns.get()).toBe(6);
    metrics.activeRuns.dec(2);
    expect(metrics.activeRuns.get()).toBe(4);
  });
});

// ── Logging tests ────────────────────────────────────────────────────────

describe("Logging", () => {
  it("should create structured log entries", () => {
    const entries: any[] = [];
    const logger = new StructuredLogger("test", (entry: any) => { entries.push(entry); });

    logger.info("test message", { runId: "run-1", correlationId: "corr-1" });
    expect(entries.length).toBe(1);
    expect(entries[0].level).toBe(LogSeverity.INFO);
    expect(entries[0].message).toBe("test message");
    expect(entries[0].component).toBe("test");
    expect(entries[0].runId).toBe("run-1");
    expect(entries[0].correlationId).toBe("corr-1");
    expect(entries[0].timestamp).toBeDefined();
  });

  it("should create child loggers", () => {
    const parent = new StructuredLogger("parent");
    const child = parent.child("child");
    child.info("child message");
    expect(true).toBe(true);
  });
});

// ── Tracing tests ────────────────────────────────────────────────────────

describe("Tracing", () => {
  it("should create and end spans", () => {
    const tracer = new Tracer("test");
    const span = tracer.startSpan("test-span", { attributes: { key: "value" } });
    expect(span.name).toBe("test-span");
    expect(span.spanId).toBeDefined();
    expect(span.traceId).toBeDefined();
    expect(span.attributes.key).toBe("value");

    tracer.endSpan(span, { code: 0, message: "ok" });
    expect(span.endTime).toBeDefined();
  });

  it("should add events to spans", () => {
    const tracer = new Tracer();
    const span = tracer.startSpan("test");
    tracer.addEvent(span, "error", { detail: "something" });
    expect(span.events.length).toBe(1);
    expect(span.events[0].name).toBe("error");
  });
});

// ── Error handling tests ─────────────────────────────────────────────────

describe("Error handling", () => {
  it("should create standardized orchestration errors", () => {
    const err = OrchestrationError.fromCode(ErrorCodes.RUN_NOT_FOUND, {
      correlationId: "corr-1",
    });
    expect(err.code).toBe("RUN_NOT_FOUND");
    expect(err.httpStatus).toBe(404);
    expect(err.retryable).toBe(false);
    expect(err.toApiResponse()).toHaveProperty("error");
    expect(err.toApiResponse().error).toHaveProperty("code", "RUN_NOT_FOUND");
  });

  it("should not expose stack in API responses", () => {
    const err = OrchestrationError.fromCode(ErrorCodes.INTERNAL_ERROR);
    const response = err.toApiResponse();
    expect(JSON.stringify(response)).not.toContain("stack");
  });

  it("should handle SEMANTIC_SATURATED error", () => {
    const err = OrchestrationError.fromCode(ErrorCodes.SEMANTIC_SATURATED);
    expect(err.code).toBe("SEMANTIC_SATURATED");
    expect(err.httpStatus).toBe(409);
    expect(err.retryable).toBe(false);
  });
});
