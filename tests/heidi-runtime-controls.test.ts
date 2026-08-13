import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { runMigrations } from "../src/orchestration/persistence/migrations/migration-runner"
import { executeToolPipeline, HeidiScheduler, selectSkill } from "../src/services/heidi-runtime-controls"

describe("Heidi runtime controls", () => {
  it("loads only capability-compatible skill metadata", () => { expect(selectSkill([{ name: "fdx", description: "native", requiredTools: ["fdx-search"] }, { name: "fallback", description: "fallback", requiredTools: ["ts-search"] }], new Set(["fdx-search"]), new Set())).toHaveLength(1) })
  it("bounds declarative pipelines and output", async () => { const result = await executeToolPipeline([{ tool: "fdx-search", args: {} }], new Set(["fdx-search"]), async () => "a very long result", { maxCalls: 2, timeoutMs: 1000, maxOutputBytes: 10 }); expect(result.truncated).toBe(true); await expect(executeToolPipeline([{ tool: "shell", args: {} }], new Set(["fdx-search"]), async () => "", { maxCalls: 2, timeoutMs: 1000, maxOutputBytes: 10 })).rejects.toThrow() })
  it("claims one due scheduled occurrence", () => { const db = new Database(":memory:"); runMigrations(db); const scheduler = new HeidiScheduler(db); scheduler.create({ name: "audit", prompt: "audit", scheduleType: "once", schedule: "2020-01-01T00:00:00.000Z", workspace: "/repo" }); expect(scheduler.claimDue("2021-01-01T00:00:00.000Z")).not.toBeNull(); expect(scheduler.claimDue("2021-01-01T00:00:00.000Z")).toBeNull(); db.close() })
})
