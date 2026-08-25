import { describe, expect, it } from "bun:test"
import { buildHeidiCoordinatorPrompt } from "../src/agents/orchestrator"
import { buildSpecialistPlan } from "../src/orchestration/routing/specialist-planner"
import { classifyTask, type ExecutionClass, type ExecutionMode } from "../src/services/heidi-fast-router"

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

function exercise(prompt: string, expectedClass: ExecutionClass, expectedMode: ExecutionMode): number {
  const startedAt = performance.now()
  const decision = classifyTask(prompt)
  const plan = buildSpecialistPlan({ runId: `performance-${expectedMode}`, goal: prompt, decision })
  const coordinatorPrompt = buildHeidiCoordinatorPrompt(undefined, decision.executionClass)
  expect(decision.executionClass).toBe(expectedClass)
  expect(plan.executionMode).toBe(expectedMode)
  expect(coordinatorPrompt.length).toBeGreaterThan(0)
  return performance.now() - startedAt
}

describe("Adaptive mode performance qualification", () => {
  it("keeps direct, single-specialist, and multi-specialist route-to-plan work bounded", () => {
    const scenarios: Array<{ name: string; prompt: string; executionClass: ExecutionClass; executionMode: ExecutionMode }> = [
      { name: "direct", prompt: "Fix a typo in the README.", executionClass: "FAST_DIRECT", executionMode: "DIRECT" },
      { name: "single", prompt: "Perform a security vulnerability scan on authentication routes.", executionClass: "SPECIALIST", executionMode: "SINGLE_SPECIALIST" },
      { name: "multi", prompt: "Coordinate frontend UI and backend API changes simultaneously.", executionClass: "PARALLEL_SPECIALISTS", executionMode: "MULTI_SPECIALIST" },
    ]

    for (const scenario of scenarios) {
      exercise(scenario.prompt, scenario.executionClass, scenario.executionMode)
      const samples = Array.from({ length: 20 }, () => exercise(scenario.prompt, scenario.executionClass, scenario.executionMode))
      expect(p95(samples)).toBeLessThan(100)
    }
  })
})
