import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  createRuntimeIntegration,
  type RuntimeOrchestrator,
  type RuntimeEvent,
  type CompletionInput,
  type VerificationInput,
} from "../../src/orchestration/runtime-integration"
import type { TaskContract, TaskContractDraft } from "../../src/orchestration/contracts/task-contract"
import { openSqliteStateStore } from "../../src/orchestration/runtime/sqlite-state-store"

function makeDraft(overrides: Partial<TaskContractDraft> = {}): TaskContractDraft {
  return {
    id: "contract-1",
    version: "1.0.0",
    objective: "Verify the runtime orchestrator",
    requirements: [],
    acceptanceCriteria: [],
    constraints: [],
    exclusions: [],
    requiredEvidence: [],
    requiredVerification: [],
    startingSha: "abc123",
    allowedMutationScope: {
      allowedPaths: ["src/"],
      deniedPaths: [],
      maxFiles: 10,
    },
    approvalGates: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    status: "draft",
    ...overrides,
  }
}

function makeVerificationInput(runId: string, contract: TaskContract, sha = "abc123"): VerificationInput {
  return { runId, sha, contract }
}

function makeCompletionInput(runId: string, sha = "abc123"): CompletionInput {
  return {
    runId,
    currentSha: sha,
    expectedSha: sha,
    assignmentsComplete: true,
    verificationResults: [
      {
        id: `vr-${runId}`,
        runId,
        ruleId: "test-suite",
        ruleDescription: "Test suite passes",
        required: true,
        status: "passed",
        targetSha: sha,
        evidenceIds: [],
      },
    ],
    acceptanceCriteria: [],
    requirements: [],
    evidenceItems: [],
    requiredEvidence: [],
  }
}

describe("RuntimeOrchestrator (runtime-integration)", () => {
  let orchestrator: RuntimeOrchestrator
  const events: RuntimeEvent[] = []

  beforeEach(() => {
    events.length = 0
    orchestrator = createRuntimeIntegration({ devMode: true })
  })

  afterEach(() => {
    orchestrator.dispose()
  })

  describe("createTask", () => {
    it("should create a run with initial state 'created' and version 0", async () => {
      const draft = makeDraft()
      const created = await orchestrator.createTask(draft)

      expect(created.runId).toBeTruthy()
      expect(created.initialState).toBe("created")
      expect(created.version).toBe(0)
      expect(created.contract.status).toBe("activated")
      expect(created.contract.activatedAt).toBeInstanceOf(Date)
      expect(created.contract.hash).toBeTruthy()
    })

    it("should emit a task_run.created event", async () => {
      const listener = (event: RuntimeEvent) => { events.push(event) }
      orchestrator.subscribe(listener)
      const created = await orchestrator.createTask(makeDraft())

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe("task_run.created")
      expect(events[0].runId).toBe(created.runId)
    })

    it("should persist the run to the state store", async () => {
      const created = await orchestrator.createTask(makeDraft())
      const state = await orchestrator.getStateStore().loadState(created.runId)
      expect(state?.state).toBe("created")
      expect(state?.version).toBe(0)
    })
  })

  describe("transition", () => {
    it("should transition created -> planning and emit task_run.transitioned", async () => {
      const listener = (event: RuntimeEvent) => { events.push(event) }
      orchestrator.subscribe(listener)

      const created = await orchestrator.createTask(makeDraft())
      const result = await orchestrator.transition(created.runId, "planning", {
        runId: created.runId,
        timestamp: Date.now(),
        reason: "test",
      })

      expect(result.success).toBe(true)
      expect(result.from).toBe("created")
      expect(result.to).toBe("planning")
      expect(events.some((e) => e.type === "task_run.transitioned")).toBe(true)

      const state = await orchestrator.getStateStore().loadState(created.runId)
      expect(state?.state).toBe("planning")
    })

    it("should reject invalid transitions and emit task_run.error", async () => {
      const listener = (event: RuntimeEvent) => { events.push(event) }
      orchestrator.subscribe(listener)

      const created = await orchestrator.createTask(makeDraft())
      // created -> completed is not allowed by the transition table
      const result = await orchestrator.transition(created.runId, "completed", {
        runId: created.runId,
        timestamp: Date.now(),
      })

      expect(result.success).toBe(false)
      expect(events.some((e) => e.type === "task_run.error")).toBe(true)

      const state = await orchestrator.getStateStore().loadState(created.runId)
      expect(state?.state).toBe("created")
    })

    it("should enforce CAS version when an expected version is supplied", async () => {
      const created = await orchestrator.createTask(makeDraft())
      const result = await orchestrator.transition(created.runId, "planning", {
        runId: created.runId,
        timestamp: Date.now(),
      }, "normal", 99 /* stale version */)

      expect(result.success).toBe(false)
    })
  })

  describe("verify", () => {
    it("should return a verification result with an empty plan", async () => {
      const created = await orchestrator.createTask(makeDraft())
      const result = await orchestrator.verify(
        makeVerificationInput(created.runId, created.contract),
      )

      expect(result).not.toBeNull()
      expect(result?.planId).toContain(created.runId)
      expect(result?.checkResults).toEqual([])
    })

    it("should surface a failed check result for a failing command", async () => {
      const created = await orchestrator.createTask(makeDraft())
      // A command that does not exist must produce a failed check result,
      // not an exception — verification results are persisted per check.
      const badContract = {
        ...created.contract,
        requiredVerification: [
          { type: "test" as const, command: "definitely-not-a-real-command-xyz", description: "x" },
        ],
      }
      const result = await orchestrator.verify({
        runId: created.runId,
        sha: "abc123",
        contract: badContract,
        cwd: tmpdir(),
      })

      expect(result).not.toBeNull()
      expect(result?.checkResults.some((cr) => cr.status === "failed")).toBe(true)
    })
  })

  describe("complete", () => {
    it("should reject a SHA mismatch before running gates", async () => {
      const created = await orchestrator.createTask(makeDraft())
      const input = makeCompletionInput(created.runId, "abc123")
      const result = await orchestrator.complete({ ...input, currentSha: "different" })

      expect(result.success).toBe(false)
      expect(result.error).toContain("SHA mismatch")
    })

    it("should reject completion for an unknown run", async () => {
      const result = await orchestrator.complete(makeCompletionInput("no-such-run"))
      expect(result.success).toBe(false)
      expect(result.error).toContain("not found")
    })

    it("should block completion when gates are not satisfied", async () => {
      const created = await orchestrator.createTask(makeDraft())
      const input: CompletionInput = {
        ...makeCompletionInput(created.runId),
        assignmentsComplete: false,
      }
      const result = await orchestrator.complete(input)

      expect(result.success).toBe(false)
      expect(result.error).toContain("Completion gates not satisfied")
      expect(result.evaluation?.allPassed).toBe(false)
    })

    it("should complete successfully when gates pass and emit task_run.completed", async () => {
      const listener = (event: RuntimeEvent) => { events.push(event) }
      orchestrator.subscribe(listener)

      const created = await orchestrator.createTask(makeDraft())
      const result = await orchestrator.complete(makeCompletionInput(created.runId))

      expect(result.success).toBe(true)
      expect(result.evaluation?.allPassed).toBe(true)
      expect(result.idempotencyRecord?.runId).toBe(created.runId)
      expect(events.some((e) => e.type === "task_run.completed")).toBe(true)

      const state = await orchestrator.getStateStore().loadState(created.runId)
      expect(state?.state).toBe("completed")
    })
  })

  describe("cancel and forceEscalation", () => {
    it("should cancel a run and emit task_run.cancelled", async () => {
      const listener = (event: RuntimeEvent) => { events.push(event) }
      orchestrator.subscribe(listener)

      const created = await orchestrator.createTask(makeDraft())
      const result = await orchestrator.cancel(created.runId, false, "test")

      expect(result.success).toBe(true)
      expect(result.runId).toBe(created.runId)
      expect(events.some((e) => e.type === "task_run.cancelled")).toBe(true)
    })

    it("should force-escalate cancellation to completed phase", async () => {
      const created = await orchestrator.createTask(makeDraft())
      const result = await orchestrator.forceEscalation(created.runId, "test-force")

      expect(result.success).toBe(true)
      expect(result.phase).toBe("completed")
    })
  })

  describe("recover", () => {
    it("should reject recovery for an unknown run", async () => {
      const result = await orchestrator.recover("no-such-run", "boom")
      expect(result.success).toBe(false)
      expect(result.error).toContain("not found")
    })

    it("should reject recovery from a non-error state", async () => {
      const created = await orchestrator.createTask(makeDraft())
      const result = await orchestrator.recover(created.runId, "boom")

      expect(result.success).toBe(false)
      expect(result.error).toContain("Cannot recover from state")
    })

    it("should recover failed -> recovering with the correct strategy", async () => {
      const created = await orchestrator.createTask(makeDraft())
      const stateStore = orchestrator.getStateStore()
      // Move the run into a failed state via direct store mutation
      await stateStore.commitTransition({
        runId: created.runId,
        state: "failed",
        expectedVersion: 0,
        event: {
          runId: created.runId,
          from: "created",
          to: "failed",
          transitionType: "normal",
          timestamp: Date.now(),
        },
      })

      const result = await orchestrator.recover(created.runId, "timeout at model call")

      expect(result.success).toBe(true)
      expect(result.strategy).toBe("resume")

      const state = await stateStore.loadState(created.runId)
      expect(state?.state).toBe("recovering")
    })

    it("should map circuit errors to abort strategy", async () => {
      const created = await orchestrator.createTask(makeDraft())
      const stateStore = orchestrator.getStateStore()
      await stateStore.commitTransition({
        runId: created.runId,
        state: "failed",
        expectedVersion: 0,
        event: {
          runId: created.runId,
          from: "created",
          to: "failed",
          transitionType: "normal",
          timestamp: Date.now(),
        },
      })

      const result = await orchestrator.recover(created.runId, "CIRCUIT breaker tripped")
      expect(result.success).toBe(true)
      expect(result.strategy).toBe("abort")
    })
  })

  describe("context budget", () => {
    it("should initialize a default context budget", async () => {
      const created = await orchestrator.createTask(makeDraft())
      const budget = await orchestrator.getContextBudget(created.runId)

      expect(budget.totalBudget).toBe(100_000)
      expect(budget.remainingBudget).toBe(100_000)
      expect(budget.isOverBudget).toBe(false)
    })

    it("should update and persist a context budget", async () => {
      const created = await orchestrator.createTask(makeDraft())
      await orchestrator.updateContextBudget(created.runId, {
        totalBudget: 1000,
        mandatoryCost: 600,
        highValueCost: 500,
        optionalCost: 100,
        remainingBudget: 0,
        isOverBudget: true,
        truncationNeeded: 200,
      })

      const budget = await orchestrator.getContextBudget(created.runId)
      expect(budget.totalBudget).toBe(1000)
      expect(budget.isOverBudget).toBe(true)
      expect(budget.truncationNeeded).toBe(200)
    })
  })

  describe("events and disposal", () => {
    it("should unsubscribe a listener", async () => {
      const listener = (event: RuntimeEvent) => { events.push(event) }
      const unsubscribe = orchestrator.subscribe(listener)
      unsubscribe()

      await orchestrator.createTask(makeDraft())
      expect(events).toHaveLength(0)
    })

    it("should tolerate listener exceptions", async () => {
      orchestrator.subscribe(() => {
        throw new Error("listener boom")
      })
      await expect(orchestrator.createTask(makeDraft())).resolves.toBeTruthy()
    })

    it("should clear state on dispose and be re-creatable", async () => {
      await orchestrator.createTask(makeDraft())
      orchestrator.dispose()

      const fresh = createRuntimeIntegration({ devMode: true })
      const created = await fresh.createTask(makeDraft())
      expect(created.runId).toBeTruthy()
      fresh.dispose()
    })
  })

  describe("SQLite-backed store integration", () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "orchestrator-it-"))
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it("should persist task creation and transitions to disk", async () => {
      const store = openSqliteStateStore(join(dir, "runtime.db"))
      const orch = createRuntimeIntegration({ stateStore: store })

      try {
        const created = await orch.createTask(makeDraft())
        expect(created.initialState).toBe("created")

        const transition = await orch.transition(created.runId, "planning", {
          runId: created.runId,
          timestamp: Date.now(),
        })
        expect(transition.success).toBe(true)

        const completion = await orch.complete(makeCompletionInput(created.runId))
        expect(completion.success).toBe(true)

        // Re-open the store to prove durability
        const reopened = openSqliteStateStore(join(dir, "runtime.db"))
        const state = await reopened.loadState(created.runId)
        expect(state?.state).toBe("completed")
        reopened.close()
      } finally {
        orch.dispose()
        store.close()
      }
    })

    it("should work with an in-memory SQLite store", async () => {
      const { createInMemoryStateStore } = await import("../../src/orchestration/runtime/sqlite-state-store")
      const store = createInMemoryStateStore()
      const orch = createRuntimeIntegration({ stateStore: store })

      try {
        const created = await orch.createTask(makeDraft())
        expect(created.initialState).toBe("created")
      } finally {
        orch.dispose()
        store.close()
      }
    })
  })

  describe("state store authority (fail-fast)", () => {
    it("should throw when no stateStore, dbPath, or devMode is configured", () => {
      expect(() => createRuntimeIntegration()).toThrow(/state store/)
    })

    it("should allow the in-memory store only as an explicit devMode opt-in", () => {
      const orch = createRuntimeIntegration({ devMode: true })
      expect(orch.getStateStore()).toBeTruthy()
      orch.dispose()
    })

    it("should open a durable SQLite store from dbPath without devMode", () => {
      const dir = mkdtempSync(join(tmpdir(), "fd-authority-"))
      const dbPath = join(dir, "runtime.db")
      const orch = createRuntimeIntegration({ dbPath })
      expect(orch.getStateStore()).toBeTruthy()
      orch.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
  })
})
