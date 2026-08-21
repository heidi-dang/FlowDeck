import { describe, it, expect } from "bun:test"
import {
  ContextSourceValidator,
  ContextConsistencyValidator,
  type ContextItem,
} from "../../../src/domain/orchestration/runtime/context-item"
import type { TaskRun } from "../../../src/domain/orchestration/runtime/task-run"

describe("ContextItem Domain Validation", () => {
  describe("ContextSourceValidator", () => {
    it("validates stable source patterns", () => {
      const validSources = [
        "ref:contract-123",
        "file:abcdef0123456789",
        "dir:0123456789abcdef",
        "symbol:CommandExecutor.execute",
        "url:https://api.github.com/repos/test",
        "agent:planner",
        "tool:git_diff",
        "session:session-abc-123",
      ]

      for (const src of validSources) {
        const res = ContextSourceValidator.validateStableSource(src)
        expect(res.valid).toBe(true)
      }
    })

    it("rejects unstable or non-matching source patterns", () => {
      const invalidSources = [
        "random-unprefixed-string",
        "unknown:123",
        "file:not-hex-XYZ!",
      ]

      for (const src of invalidSources) {
        const res = ContextSourceValidator.validateStableSource(src)
        expect(res.valid).toBe(false)
        if (!res.valid) {
          expect(res.errors.length).toBeGreaterThan(0)
          expect(res.errors[0]).toContain("is not a stable identifier")
        }
      }
    })

    it("rejects mutable filesystem paths", () => {
      const paths = ["/etc/passwd", "/tmp/scratch.txt", "C:\\Users\\Desktop\\file.ts"]
      for (const p of paths) {
        const res = ContextSourceValidator.validateStableSource(p)
        expect(res.valid).toBe(false)
        if (!res.valid) {
          expect(res.errors.some((e) => e.includes("mutable filesystem path"))).toBe(true)
        }
      }
    })
  })

  describe("ContextConsistencyValidator", () => {
    it("validates run ownership", () => {
      const ctx: Pick<ContextItem, "id" | "runId" | "status"> = {
        id: "ctx-1",
        runId: "run-1",
        status: "active",
      }

      // Non-existent run
      const noRun = ContextConsistencyValidator.validateRunOwnership(ctx, undefined)
      expect(noRun.valid).toBe(false)
      if (!noRun.valid) {
        expect(noRun.errors[0]).toContain("references non-existent run")
      }

      // Active run
      const runningRun: TaskRun = {
        aggregateId: "run-1",
        version: 1,
        status: "executing",
        strategy: "planned",
      }
      const validRunRes = ContextConsistencyValidator.validateRunOwnership(ctx, runningRun)
      expect(validRunRes.valid).toBe(true)

      // Completed run with active context -> invalid
      const completedRun: TaskRun = {
        ...runningRun,
        status: "completed",
      }
      const invalidCompleted = ContextConsistencyValidator.validateRunOwnership(ctx, completedRun)
      expect(invalidCompleted.valid).toBe(false)
      if (!invalidCompleted.valid) {
        expect(invalidCompleted.errors[0]).toContain("Cannot add new context to completed run")
      }

      // Completed run with archived or deleted context -> valid
      const archivedCtx = { ...ctx, status: "archived" as const }
      expect(ContextConsistencyValidator.validateRunOwnership(archivedCtx, completedRun).valid).toBe(true)

      const deletedCtx = { ...ctx, status: "deleted" as const }
      expect(ContextConsistencyValidator.validateRunOwnership(deletedCtx, completedRun).valid).toBe(true)
    })

    it("validates source stability via helper", () => {
      expect(ContextConsistencyValidator.validateSourceStability({ source: "ref:123" }).valid).toBe(true)
      expect(ContextConsistencyValidator.validateSourceStability({ source: "/invalid" }).valid).toBe(false)
    })

    it("validates no cross-run mutations", () => {
      const ctx: ContextItem = {
        id: "ctx-1",
        runId: "run-1",
        type: "codebase-summary",
        title: "Summary",
        content: "details",
        source: "ref:1",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        referencedByRunIds: ["run-2"],
      }

      const runsMap = new Map<string, TaskRun>()

      // Not a mutation
      expect(ContextConsistencyValidator.validateNoCrossRunMutations(ctx, runsMap, false).valid).toBe(true)

      // Mutation with running referenced run
      runsMap.set("run-2", {
        aggregateId: "run-2",
        version: 1,
        status: "executing",
        strategy: "planned",
      })
      expect(ContextConsistencyValidator.validateNoCrossRunMutations(ctx, runsMap, true).valid).toBe(true)

      // Mutation with terminal referenced run (completed/failed/cancelled)
      runsMap.set("run-2", {
        aggregateId: "run-2",
        version: 1,
        status: "completed",
        strategy: "planned",
      })
      const terminalRes = ContextConsistencyValidator.validateNoCrossRunMutations(ctx, runsMap, true)
      expect(terminalRes.valid).toBe(false)
      if (!terminalRes.valid) {
        expect(terminalRes.errors[0]).toContain("referencing run(s) are in terminal states")
      }
    })

    it("lists unique sources", async () => {
      const items = [
        { source: "ref:1" },
        { source: "file:abc" },
        { source: "ref:1" },
        { source: "tool:lint" },
      ]
      const sources = await ContextConsistencyValidator.listUniqueSources(items)
      expect(sources).toEqual(["ref:1", "file:abc", "tool:lint"])
    })
  })
})
