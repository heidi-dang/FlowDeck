import { describe, expect, it } from "bun:test"
import { AuthoritativeRoutingService } from "../../src/orchestration/routing"
import { routeTask } from "../../src/orchestration/routing/intelligence"

const sourceSha = "0123456789abcdef0123456789abcdef01234567"
const evidence = { milestone1: true, executionPlanner: true, adaptiveBudget: true, performanceIntelligence: true, determinism: true, safety: true, modelAuthority: true, budgetAuthority: true, completionAuthority: true }

describe("authoritative routing activation", () => {
  it("fails closed for stale decisions", () => {
    const decision = routeTask({ runId: "run", sourceSha, task: "small bug" })
    const service = new AuthoritativeRoutingService({ savePlan: () => { throw new Error("not reached") } } as never)
    const result = service.activate(decision, "fedcba9876543210fedcba9876543210fedcba98", evidence)
    expect(result.fallback).toBe(true)
    expect((result as { reason: string }).reason).toContain("STALE")
  })

  it("requires all readiness evidence before enforce", () => {
    const decision = routeTask({ runId: "run", sourceSha, task: "small bug" })
    const service = new AuthoritativeRoutingService({ savePlan: () => { throw new Error("not reached") } } as never)
    const result = service.activate(decision, decision.sourceSha, { ...evidence, adaptiveBudget: false })
    expect(result.fallback).toBe(true)
    expect((result as { reason: string }).reason).toContain("NOT_READY")
  })

  it("turns one persisted decision into a deterministic execution plan", () => {
    let savedPlan: any
    const decision = routeTask({ runId: "run", sourceSha, task: "Implement a cross-layer feature across the api ui database and tests", paths: ["src/api/a.ts", "src/ui/a.ts", "src/db/a.ts", "tests/a.ts"] })
    const service = new AuthoritativeRoutingService({ savePlan: (plan: unknown) => { savedPlan = plan; return plan } } as never)
    const result = service.activate(decision, sourceSha, evidence)
    expect(result.fallback).toBe(false)
    expect(savedPlan.planId).toBe(`plan_${decision.routingDecisionId}`)
    expect(savedPlan.workstreams.map((w: any) => w.workstreamId)).toEqual([...savedPlan.workstreams].map((w: any) => w.workstreamId).sort())
    expect(new Set(savedPlan.workstreams.map((w: any) => w.resolvedAgent)).size).toBeGreaterThan(1)
  })

  it("executes only through an explicitly injected dispatcher", async () => {
    const decision = routeTask({ runId: "run-dispatch", sourceSha, task: "small bug" })
    let calls = 0
    const service = new AuthoritativeRoutingService({ savePlan: (plan: unknown) => plan } as never, {
      executePlan: async (_planId, _sha, executor) => {
        calls += 1
        const result = await executor.execute({} as never, {} as never)
        return { succeeded: result === "succeeded" ? ["direct"] : [], failed: result === "failed" ? ["direct"] : [], blocked: [] }
      },
    })
    const result = await service.activateAndExecute(decision, sourceSha, evidence, { execute: async () => "succeeded" })
    expect(result.fallback).toBe(false)
    expect(calls).toBe(1)
    expect((result as { execution: { succeeded: string[] } }).execution.succeeded).toEqual(["direct"])
  })
})
