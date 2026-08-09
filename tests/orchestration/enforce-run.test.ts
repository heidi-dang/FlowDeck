import { describe, expect, it } from "bun:test"
import { createEnforceRun } from "../../src/orchestration/routing/enforce-run"

describe("durable enforce run boundary", () => {
  it("creates a task run instead of using an OpenCode session as the run identity", async () => {
    const calls: unknown[] = []
    const run = await createEnforceRun({
      createRun: async input => {
        calls.push(input)
        return { id: "durable-run", ...input } as never
      },
    }, "ses-123", "heidi", "0123456789abcdef0123456789abcdef01234567")
    expect(run.id).toBe("durable-run")
    expect(calls).toEqual([{
      runType: "autonomous-execution",
      correlationId: "flowdeck:enforce:ses-123",
      sessionId: "ses-123",
      agentId: "heidi",
      metadata: { routingMode: "enforce", sourceSha: "0123456789abcdef0123456789abcdef01234567" },
    }])
  })

  it("fails closed on invalid source state", async () => {
    await expect(createEnforceRun({ createRun: async () => ({ id: "unused" } as never) }, "ses", "heidi", "not-a-sha")).rejects.toThrow("ENFORCE_SOURCE_SHA_INVALID")
  })
})
