import { describe, it, expect } from "bun:test";
import { TERMINAL_STATES, TRANSITION_MATRIX, STRATEGY_RULES } from "../src/domain/orchestration/runtime/task-run";
import {
  InMemoryTaskRunRepository,
  InMemoryAssignmentRepository,
  InMemorySessionRepository,
  InMemoryContextItemRepository,
  InMemoryRuntimeRequirementRepository,
  InMemoryAcceptanceCriterionStateRepository,
  InMemoryWorktreeOwnershipRepository,
} from "../src/domain/orchestration/runtime/in-memory-repositories";
import { InMemoryRuntimeEventStore } from "../src/domain/orchestration/runtime/event-store/in-memory-store";

describe("Domain Orchestration Runtime State Machine & Repositories Coverage", () => {
  it("validates TERMINAL_STATES set", () => {
    expect(TERMINAL_STATES.has("completed")).toBe(true);
    expect(TERMINAL_STATES.has("failed")).toBe(true);
    expect(TERMINAL_STATES.has("cancelled")).toBe(true);
    expect(TERMINAL_STATES.has("created")).toBe(false);
  });

  it("validates TRANSITION_MATRIX for all state definitions", () => {
    const states = Object.keys(TRANSITION_MATRIX);
    expect(states).toContain("created");
    expect(states).toContain("planning");
    expect(states).toContain("analysing");
    expect(states).toContain("delegating");
    expect(states).toContain("executing");
    expect(states).toContain("verifying");
    expect(states).toContain("recovering");

    const createdTransitions = TRANSITION_MATRIX.created;
    expect(createdTransitions.length).toBeGreaterThan(0);
    const dummyRun: any = { aggregateId: "r1", version: 1, status: "created", strategy: "simple", planningCompleted: true };

    for (const tr of createdTransitions) {
      for (const inv of tr.invariants) {
        expect(typeof inv(dummyRun)).toBe("boolean");
      }
      expect(Array.isArray(tr.emit())).toBe(true);
    }
  });

  it("validates STRATEGY_RULES", () => {
    const runSimple: any = { strategy: "simple" };
    const runPlanned: any = { strategy: "planned" };
    const runDelegated: any = { strategy: "delegated" };
    const runAudit: any = { strategy: "audit" };
    const runRecovery: any = { strategy: "recovery" };

    expect(STRATEGY_RULES.simple(runSimple)).toBe(true);
    expect(STRATEGY_RULES.planned(runPlanned)).toBe(true);
    expect(STRATEGY_RULES.delegated(runDelegated)).toBe(true);
    expect(STRATEGY_RULES.audit(runAudit)).toBe(true);
    expect(STRATEGY_RULES.recovery(runRecovery)).toBe(true);
  });

  it("exercises InMemoryTaskRunRepository CRUD methods", async () => {
    const repo = new InMemoryTaskRunRepository();
    const run: any = {
      aggregateId: "run-dom-1",
      version: 1,
      status: "created",
      strategy: "simple",
      correlationId: "corr-1",
    };

    await repo.save(run);
    const retrieved = await repo.findById("run-dom-1");
    expect(retrieved?.aggregateId).toBe("run-dom-1");

    const byCorr = await repo.findByCorrelationId("corr-1");
    expect(byCorr.length).toBe(1);

    const byStatus = await repo.listByStatus(["created"], 10);
    expect(byStatus.length).toBe(1);

    const all = repo.getAll();
    expect(all.length).toBe(1);

    const ensured = await repo.ensureExists(run);
    expect(ensured).toBe(false);

    await repo.save({ ...run, version: 2 });
    expect(repo.save({ ...run, version: 1 })).rejects.toThrow();

    repo.clear();
    expect(repo.getAll().length).toBe(0);
  });

  it("exercises InMemoryAssignmentRepository CRUD methods", async () => {
    const repo = new InMemoryAssignmentRepository();
    const assignment: any = { id: "a-1", runId: "r-1", agentName: "agent-1", status: "assigned" };

    await repo.save(assignment);
    expect(await repo.findById("a-1")).toBeDefined();
    expect((await repo.findByRunId("r-1")).length).toBe(1);
    expect(await repo.validateUniqueness({ id: "a-2", runId: "r-1", agentName: "agent-1" })).toBe(false);

    await repo.delete("a-1");
    expect(await repo.findById("a-1")).toBeUndefined();
    repo.clear();
  });

  it("exercises InMemorySessionRepository CRUD methods", async () => {
    const repo = new InMemorySessionRepository();
    const session: any = { id: "s-1", runId: "r-1", agentName: "agent-1", status: "active" };

    await repo.save(session);
    expect(await repo.findById("s-1")).toBeDefined();
    expect(await repo.findByRunAndAgent("r-1", "agent-1")).toBeDefined();
    expect((await repo.findByRunId("r-1")).length).toBe(1);
    expect(repo.getActiveSessionsForRun("r-1").length).toBe(1);

    await repo.delete("s-1");
    expect(await repo.findById("s-1")).toBeUndefined();
    repo.clear();
  });

  it("exercises InMemoryContextItemRepository CRUD methods", async () => {
    const repo = new InMemoryContextItemRepository();
    const context: any = { id: "c-1", runId: "r-1", source: "file1.ts", content: "data" };

    await repo.save(context);
    expect(await repo.findById("c-1")).toBeDefined();
    expect((await repo.findByRunId("r-1")).length).toBe(1);
    expect((await repo.listSources("r-1")).length).toBe(1);
    expect(repo.getBySource("file1.ts")).toBeDefined();

    await repo.delete("c-1");
    expect(await repo.findById("c-1")).toBeUndefined();
    repo.clear();
  });

  it("exercises InMemoryRuntimeRequirementRepository CRUD methods", async () => {
    const repo = new InMemoryRuntimeRequirementRepository();
    const req: any = { id: "req-1", runId: "r-1", title: "Req 1" };

    await repo.save(req);
    expect(await repo.findById("req-1")).toBeDefined();
    expect((await repo.findByRunId("r-1")).length).toBe(1);
    await repo.delete("req-1");
    repo.clear();
  });

  it("exercises InMemoryAcceptanceCriterionStateRepository CRUD methods", async () => {
    const repo = new InMemoryAcceptanceCriterionStateRepository();
    const item: any = { id: "ac-1", runId: "r-1", sequenceOrder: 2 };
    const item2: any = { id: "ac-2", runId: "r-1", sequenceOrder: 1 };

    await repo.save(item);
    await repo.save(item2);

    expect(await repo.findById("ac-1")).toBeDefined();
    const sorted = await repo.getSortedBySequence("r-1");
    expect(sorted[0].id).toBe("ac-2");

    await repo.delete("ac-1");
    repo.clear();
  });

  it("exercises InMemoryWorktreeOwnershipRepository CRUD methods", async () => {
    const repo = new InMemoryWorktreeOwnershipRepository();

    const claimed = await repo.claimOwnership("wt-1", "owner-1");
    expect(claimed).toBe(true);
    expect(await repo.getOwner("wt-1")).toBe("owner-1");
    expect(await repo.isOwnedBy("wt-1", "owner-1")).toBe(true);
    expect(await repo.claimOwnership("wt-1", "owner-2")).toBe(false);

    expect(repo.getAllOwnerships().size).toBe(1);

    await repo.releaseOwnership("wt-1");
    expect(await repo.getOwner("wt-1")).toBeUndefined();
    repo.clear();
  });

  it("exercises InMemoryRuntimeEventStore methods", async () => {
    const store = new InMemoryRuntimeEventStore();
    const event: any = {
      eventId: "e-1",
      eventType: "RunCreated",
      payload: { runId: "r-1" },
      aggregateId: "r-1",
      aggregateType: "TaskRun",
    };

    const result = await store.append("r-1", [event], 0);
    expect(result.events.length).toBe(1);
    expect(await store.getAggregateVersion("r-1")).toBe(1);

    const stream = await store.readStream("r-1");
    expect(stream.length).toBe(1);
  });
});
