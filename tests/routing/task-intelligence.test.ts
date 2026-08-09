import { describe, expect, it } from "bun:test"
import { assessTask, classifyTask, routeTask } from "@/orchestration/routing/intelligence"
import { TASK_CLASSES, assertUniqueEvidence, routingDecisionSchema } from "@/orchestration/routing/contracts/task-intelligence"

const base = { runId: "run-1", sourceSha: "0123456789012345678901234567890123456789" }

describe("v2 task intelligence", () => {
  it("exhaustively exposes a finite taxonomy", () => expect(TASK_CLASSES).toContain("multi_component"))
  it("classifies identical normalized inputs deterministically", () => {
    const a = { ...base, task: "  Fix   auth bug  ", paths: ["src/auth.ts"] }
    expect(classifyTask(a)).toBe("security")
    expect(assessTask(a)).toEqual(assessTask({ ...a, paths: ["src/auth.ts"] }))
  })
  it("keeps complexity and ambiguity independent", () => {
    const a = assessTask({ ...base, task: "Implement feature", paths: ["src/a.ts", "src/b.ts"] })
    const b = assessTask({ ...base, task: "Implement this feature with explicit acceptance criteria", paths: ["src/a.ts", "src/b.ts"] , constraints: ["criteria: tests pass"] })
    expect(a.complexity.score).toBe(b.complexity.score)
    expect(a.ambiguity.score).toBeGreaterThan(b.ambiguity.score)
  })
  it("enforces a security risk floor with evidence", () => {
    const result = assessTask({ ...base, task: "Update authentication secret handling" })
    expect(result.risk.score).toBeGreaterThanOrEqual(75)
    expect(result.risk.evidence.length).toBeGreaterThan(0)
  })
  it("rejects duplicate evidence ids", () => {
    expect(() => assertUniqueEvidence([{ id: "x", kind: "a", signal: "a", value: "1", weight: 1 }, { id: "x", kind: "b", signal: "b", value: "2", weight: 2 }])).toThrow("ROUTING_DUPLICATE_EVIDENCE")
  })
  it("routes a cross-layer task deterministically and recommends canonical specialists", () => {
    const result = routeTask({ ...base, task: "Implement feature across API and UI", paths: ["src/api/routes.ts", "src/ui/App.tsx", "tests/integration.ts", "docs/api.md"] })
    expect(result.strategy).toBe("parallel_implementation")
    expect(result.delegate).toBe(true)
    expect(result.delegations.map(d => d.agentId)).toEqual(["backend-coder", "frontend-coder", "tester"])
    expect(routingDecisionSchema.parse(result)).toEqual(result)
  })
  it("does not change model authority", () => expect(routeTask({ ...base, task: "Fix a typo", paths: ["README.md"] }).modelRecommendation).toContain("advisory-only"))
})
