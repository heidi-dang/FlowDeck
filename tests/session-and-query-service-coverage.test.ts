import { describe, it, expect } from "bun:test";
import { SessionConsistencyValidator } from "../src/domain/orchestration/runtime/session";
import { QueryService } from "../src/orchestration/services/query-service";
import { OutboxStatus } from "../src/orchestration/types";

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<any> = {}): any {
  return {
    id: "session-1",
    runId: "run-1",
    agentName: "coder",
    title: "Coding session",
    status: "created",
    mode: "planning",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRun(state = "created"): any {
  return {
    aggregateId: "run-1",
    version: 1,
    status: state,
    strategy: "simple",
  };
}

// ─── SessionConsistencyValidator tests ────────────────────────────────────

describe("SessionConsistencyValidator.validateRunOwnership", () => {
  it("returns valid=false when run is undefined", () => {
    const session = makeSession();
    const result = SessionConsistencyValidator.validateRunOwnership(session, undefined);
    expect(result.valid).toBe(false);
    expect((result as any).errors[0]).toContain("non-existent run");
  });

  it("returns valid=true for compatible mode and run state", () => {
    const session = makeSession({ mode: "planning" });
    const run = makeRun("created");
    const result = SessionConsistencyValidator.validateRunOwnership(session, run);
    expect(result.valid).toBe(true);
  });

  it("returns valid=false for incompatible mode and run state", () => {
    const session = makeSession({ mode: "execution" });
    const run = makeRun("created");
    const result = SessionConsistencyValidator.validateRunOwnership(session, run);
    expect(result.valid).toBe(false);
    expect((result as any).errors.length).toBeGreaterThan(0);
  });

  it("returns valid=true for analysis mode in analysing state", () => {
    const session = makeSession({ mode: "analysis" });
    const run = makeRun("analysing");
    const result = SessionConsistencyValidator.validateRunOwnership(session, run);
    expect(result.valid).toBe(true);
  });

  it("returns valid=false for any mode in completed state", () => {
    const session = makeSession({ mode: "planning" });
    const run = makeRun("completed");
    const result = SessionConsistencyValidator.validateRunOwnership(session, run);
    expect(result.valid).toBe(false);
  });
});

describe("SessionConsistencyValidator.validateModeCompatibility", () => {
  it("planning mode allowed in created state", () => {
    const result = SessionConsistencyValidator.validateModeCompatibility("created", "planning");
    expect(result.valid).toBe(true);
  });

  it("analysis mode allowed in analysing state", () => {
    const result = SessionConsistencyValidator.validateModeCompatibility("analysing", "analysis");
    expect(result.valid).toBe(true);
  });

  it("execution mode allowed in delegating state", () => {
    const result = SessionConsistencyValidator.validateModeCompatibility("delegating", "execution");
    expect(result.valid).toBe(true);
  });

  it("audit mode allowed in verifying state", () => {
    const result = SessionConsistencyValidator.validateModeCompatibility("verifying", "audit");
    expect(result.valid).toBe(true);
  });

  it("recovery mode allowed in recovering state", () => {
    const result = SessionConsistencyValidator.validateModeCompatibility("recovering", "recovery");
    expect(result.valid).toBe(true);
  });

  it("execution mode NOT allowed in planning state", () => {
    const result = SessionConsistencyValidator.validateModeCompatibility("planning", "execution");
    expect(result.valid).toBe(false);
    expect((result as any).errors[0]).toContain("not compatible");
  });

  it("no modes allowed in failed state", () => {
    const result = SessionConsistencyValidator.validateModeCompatibility("failed", "planning");
    expect(result.valid).toBe(false);
  });

  it("no modes allowed in cancelled state", () => {
    const result = SessionConsistencyValidator.validateModeCompatibility("cancelled", "execution");
    expect(result.valid).toBe(false);
  });
});

describe("SessionConsistencyValidator.validateUniqueness", () => {
  it("returns valid=true when no other active sessions for same agent", () => {
    const session = makeSession();
    const result = SessionConsistencyValidator.validateUniqueness(session, []);
    expect(result.valid).toBe(true);
  });

  it("returns valid=false when active session exists for same agent in same run", () => {
    const session = makeSession({ id: "session-2" });
    const existing = makeSession({ id: "session-1", status: "active" });
    const result = SessionConsistencyValidator.validateUniqueness(session, [existing]);
    expect(result.valid).toBe(false);
    expect((result as any).errors[0]).toContain("Active session already exists");
  });

  it("returns valid=true when allowConcurrent is true", () => {
    const session = makeSession({ id: "session-2" });
    const existing = makeSession({ id: "session-1", status: "active" });
    const result = SessionConsistencyValidator.validateUniqueness(session, [existing], true);
    expect(result.valid).toBe(true);
  });

  it("returns valid=true for self-reference (same id)", () => {
    const session = makeSession({ id: "session-1" });
    const existing = makeSession({ id: "session-1", status: "active" });
    const result = SessionConsistencyValidator.validateUniqueness(session, [existing]);
    expect(result.valid).toBe(true);
  });

  it("allows multiple sessions from different agents in same run", () => {
    const session = makeSession({ id: "session-2", agentName: "reviewer" });
    const existing = makeSession({ id: "session-1", agentName: "coder", status: "active" });
    const result = SessionConsistencyValidator.validateUniqueness(session, [existing]);
    expect(result.valid).toBe(true);
  });
});

describe("SessionConsistencyValidator.validateNoCrossRunDependencies", () => {
  it("returns valid=true with no parent session", () => {
    const session = makeSession();
    const result = SessionConsistencyValidator.validateNoCrossRunDependencies(session, undefined, []);
    expect(result.valid).toBe(true);
  });

  it("returns valid=true when parent is in same run", () => {
    const session = makeSession({ id: "child", parentId: "parent" });
    const parent = makeSession({ id: "parent", runId: "run-1" });
    const result = SessionConsistencyValidator.validateNoCrossRunDependencies(session, parent, [session, parent]);
    expect(result.valid).toBe(true);
  });

  it("returns valid=false when parent is in different run", () => {
    const session = makeSession({ id: "child", runId: "run-1", parentId: "parent" });
    const parent = makeSession({ id: "parent", runId: "run-2" });
    const result = SessionConsistencyValidator.validateNoCrossRunDependencies(session, parent, [session, parent]);
    expect(result.valid).toBe(false);
    expect((result as any).errors[0]).toContain("different run");
  });
});

// ─── QueryService tests ───────────────────────────────────────────────────

function makePaginatedResult<T>(items: T[]): any {
  return { items, total: items.length, page: 1, limit: 10 };
}

function makeRepo(items: any[] = []): any {
  return {
    findMany: async () => makePaginatedResult(items),
    findById: async (id: string) => items.find((x: any) => x.id === id) ?? null,
    count: async () => items.length,
  };
}

describe("QueryService", () => {
  function makeService(overrides: Partial<any> = {}): QueryService {
    const defaults = {
      runRepo: makeRepo(),
      contractRepo: makeRepo(),
      assignmentRepo: makeRepo(),
      verificationRepo: makeRepo(),
      eventRepo: makeRepo(),
      outboxRepo: makeRepo(),
    };
    const merged = { ...defaults, ...overrides };
    return new QueryService(
      merged.runRepo, merged.contractRepo, merged.assignmentRepo,
      merged.verificationRepo, merged.eventRepo, merged.outboxRepo
    );
  }

  it("listRuns returns paginated response", async () => {
    const svc = makeService({ runRepo: makeRepo([{ id: "run-1" }]) });
    const result = await svc.listRuns({} as any, { page: 1, limit: 10 });
    expect(result.items.length).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it("getRun returns run when found", async () => {
    const svc = makeService({ runRepo: makeRepo([{ id: "run-1" }]) });
    const run = await svc.getRun("run-1");
    expect(run.id).toBe("run-1");
  });

  it("getRun throws when run not found", async () => {
    const svc = makeService();
    await expect(svc.getRun("missing")).rejects.toThrow();
  });

  it("getContract throws when not found", async () => {
    const svc = makeService();
    await expect(svc.getContract("missing")).rejects.toThrow();
  });

  it("getContract returns contract when found", async () => {
    const svc = makeService({ contractRepo: makeRepo([{ id: "c-1" }]) });
    const c = await svc.getContract("c-1");
    expect(c.id).toBe("c-1");
  });

  it("listContracts returns paginated response", async () => {
    const svc = makeService({ contractRepo: makeRepo([{ id: "c-1" }]) });
    const result = await svc.listContracts({} as any, { page: 1, limit: 10 });
    expect(result.items.length).toBe(1);
  });

  it("listAssignments returns paginated response", async () => {
    const svc = makeService({ assignmentRepo: makeRepo([{ id: "a-1" }]) });
    const result = await svc.listAssignments({} as any, { page: 1, limit: 10 });
    expect(result.items.length).toBe(1);
  });

  it("getAssignment throws when not found", async () => {
    const svc = makeService();
    await expect(svc.getAssignment("missing")).rejects.toThrow();
  });

  it("getAssignment returns assignment when found", async () => {
    const svc = makeService({ assignmentRepo: makeRepo([{ id: "a-1" }]) });
    const a = await svc.getAssignment("a-1");
    expect(a.id).toBe("a-1");
  });

  it("listVerifications returns paginated response", async () => {
    const svc = makeService({ verificationRepo: makeRepo([{ id: "v-1" }]) });
    const result = await svc.listVerifications({} as any, { page: 1, limit: 10 });
    expect(result.items.length).toBe(1);
  });

  it("getVerification throws when not found", async () => {
    const svc = makeService();
    await expect(svc.getVerification("missing")).rejects.toThrow();
  });

  it("getVerification returns verification when found", async () => {
    const svc = makeService({ verificationRepo: makeRepo([{ id: "v-1" }]) });
    const v = await svc.getVerification("v-1");
    expect(v.id).toBe("v-1");
  });

  it("listEvidence returns empty array", async () => {
    const svc = makeService();
    const result = await svc.listEvidence({} as any);
    expect(result).toEqual([]);
  });

  it("getEvidence always throws", async () => {
    const svc = makeService();
    await expect(svc.getEvidence("any")).rejects.toThrow();
  });

  it("listEvents returns paginated response", async () => {
    const svc = makeService({ eventRepo: makeRepo([{ id: "ev-1" }]) });
    const result = await svc.listEvents({} as any, { page: 1, limit: 10 });
    expect(result.items.length).toBe(1);
  });

  it("getEvent throws when not found", async () => {
    const svc = makeService();
    await expect(svc.getEvent("missing")).rejects.toThrow();
  });

  it("getEvent returns event when found", async () => {
    const svc = makeService({ eventRepo: makeRepo([{ id: "ev-1" }]) });
    const ev = await svc.getEvent("ev-1");
    expect(ev.id).toBe("ev-1");
  });

  it("listOutboxEntries returns paginated response", async () => {
    const svc = makeService({ outboxRepo: makeRepo([{ id: "ob-1" }]) });
    const result = await svc.listOutboxEntries({} as any, { page: 1, limit: 10 });
    expect(result.items.length).toBe(1);
  });

  it("getOutboxEntry throws when not found", async () => {
    const svc = makeService();
    await expect(svc.getOutboxEntry("missing")).rejects.toThrow();
  });

  it("getOutboxEntry returns entry when found", async () => {
    const svc = makeService({ outboxRepo: makeRepo([{ id: "ob-1" }]) });
    const ob = await svc.getOutboxEntry("ob-1");
    expect(ob.id).toBe("ob-1");
  });

  it("getDeliveryStatus returns counts for pending/delivered/failed", async () => {
    const outboxRepo = {
      findMany: async () => makePaginatedResult([]),
      findById: async () => null,
      count: async (filter: any) => {
        if (filter.status === OutboxStatus.PENDING) return 3;
        if (filter.status === OutboxStatus.DELIVERED) return 5;
        if (filter.status === OutboxStatus.FAILED) return 1;
        return 0;
      },
    };
    const svc = makeService({ outboxRepo });
    const status = await svc.getDeliveryStatus("run-1");
    expect(status.pending).toBe(3);
    expect(status.delivered).toBe(5);
    expect(status.failed).toBe(1);
  });
});
