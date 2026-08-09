import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { routeTask } from "@/orchestration/routing/intelligence"
import { JsonlRoutingDecisionStore } from "@/orchestration/routing/store"
import { explainRouting, runShadowAssessment } from "@/orchestration/routing/shadow"
import { validateWorkstreams } from "@/orchestration/routing/planning"

const input = { runId: "run-shadow", sourceSha: "0123456789012345678901234567890123456789", task: "Implement authentication migration", paths: ["src/auth.ts", "schema-v0.2.6.sql"] }

describe("routing shadow mode and persistence", () => {
  it("off mode does not compute or persist a decision", () => expect(runShadowAssessment(input, "direct", "off")).toEqual({ mode: "off", decision: null, existingStrategy: "direct", divergent: false }))
  it("shadow mode persists an explainable decision without changing existing strategy", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowdeck-routing-")), store = new JsonlRoutingDecisionStore(join(dir, "decisions.jsonl"))
    const result = runShadowAssessment(input, "direct", "shadow", store)
    expect(result.decision).not.toBeNull()
    expect(result.existingStrategy).toBe("direct")
    expect(result.divergent).toBe(true)
    expect(explainRouting(result.decision!)).toMatchObject({ taskClass: "security", strategy: "security_review" })
    expect(store.list("run-shadow")).toHaveLength(1)
    expect(new JsonlRoutingDecisionStore(join(dir, "decisions.jsonl")).get(result.decision!.routingDecisionId)).toEqual(result.decision)
    expect(() => store.append(result.decision!)).toThrow("ROUTING_DECISION_IMMUTABLE")
    rmSync(dir, { recursive: true, force: true })
  })
  it("does not create a budget reservation or model override", () => {
    const decision = routeTask({ ...input, task: "Fix a typo", paths: ["README.md"] })
    expect(decision.modelRecommendation).toContain("advisory-only")
    expect(decision.budgetRecommendation).toBe("small")
  })
  it("rejects overlapping ownership and dependency cycles", () => {
    expect(() => validateWorkstreams([{ id: "a", ownership: ["src"], dependsOn: [], rationale: "a" }, { id: "b", ownership: ["src/ui"], dependsOn: [], rationale: "b" }])).toThrow("ROUTING_OVERLAPPING_OWNERSHIP")
    expect(() => validateWorkstreams([{ id: "a", ownership: ["a"], dependsOn: ["b"], rationale: "a" }, { id: "b", ownership: ["b"], dependsOn: ["a"], rationale: "b" }])).toThrow("ROUTING_DEPENDENCY_CYCLE")
  })
})
