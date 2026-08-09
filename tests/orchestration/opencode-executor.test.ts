import { describe, expect, it } from "bun:test"
import { OpenCodeWorkstreamExecutor } from "../../src/orchestration/execution/opencode-executor"
import { buildWorkstreamContext } from "../../src/orchestration/execution/context"

const workstream = { workstreamId: "ws", runId: "run", planId: "plan", resolvedAgent: "backend-coder", requiredCapability: "backend", objective: "implement", requirements: ["contract"], acceptanceCriteria: ["tests pass"], ownedPaths: ["src/api/**"], ownedSymbols: [], dependsOn: [], strategy: "direct", budgetProfile: "normal" as const, contextScope: "owned" as const, status: "running" as const, blockedBy: [], createdAt: "2026-08-09T00:00:00.000Z" }
const allocation = { worktreeId: "wt", workspace: "/tmp/worktree", branch: "flowdeck/wt", sourceSha: "0123456789abcdef0123456789abcdef01234567" }

describe("explicit OpenCode enforce executor", () => {
  it("creates and prompts a session in the allocated worktree without selecting a model/provider", async () => {
    let created: any
    let prompted: any
    const client = { session: { create: async (input: unknown) => { created = input; return { data: { id: "session-1" } } }, prompt: async (input: unknown) => { prompted = input; return { data: { info: { id: "message-1" } } } } } }
    const executor = new OpenCodeWorkstreamExecutor(client, () => true)
    const result = await executor.execute(workstream, allocation, undefined, buildWorkstreamContext(workstream))
    expect(result.status).toBe("succeeded")
    expect(result.verificationPassed).toBe(true)
    expect(created.query.directory).toBe(allocation.workspace)
    expect(created.body.agent).toBe("backend-coder")
    expect(created.body.model).toBeUndefined()
    expect(prompted.query.directory).toBe(allocation.workspace)
    expect(prompted.body.agent).toBe("backend-coder")
    expect(prompted.body.parts[0].text).toContain("implement")
  })

  it("fails closed when the OpenCode session API is unavailable", async () => {
    await expect(new OpenCodeWorkstreamExecutor({}).execute(workstream, allocation)).rejects.toThrow("OPENCODE_WORKSTREAM_API_UNAVAILABLE")
  })

  it("reserves and reconciles the existing workstream budget authority", async () => {
    let reserveCalls = 0
    let reconcileCalls = 0
    let terminateCalls = 0
    const budget = {
      profile: "normal",
      reserve: async () => { reserveCalls += 1; return { allowed: true, reservationId: "reservation-1", remainingRun: 1000, claimed: 100 } },
      reconcile: async () => { reconcileCalls += 1; return { committed: true, reclaimed: 40, remainingRun: 940 } },
      terminate: async () => { terminateCalls += 1 },
      observe: async () => ({ stalled: false, reasons: [] }),
    }
    const client = { session: { create: async () => ({ data: { id: "session-budget" } }), prompt: async () => ({ data: { info: { id: "message-budget" } } }) } }
    const result = await new OpenCodeWorkstreamExecutor(client, () => true).execute(workstream, allocation, budget as any, buildWorkstreamContext(workstream))
    expect(result.status).toBe("succeeded")
    expect(reserveCalls).toBe(1)
    expect(reconcileCalls).toBe(1)
    expect(terminateCalls).toBe(0)
  })
})
