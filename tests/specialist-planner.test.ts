import { describe, expect, it } from "bun:test"
import { classifyTask } from "../src/services/heidi-fast-router"
import {
  assertValidSpecialistPlan,
  buildSpecialistPlan,
  parseSpecialistPlan,
  readySpecialistSpecs,
} from "../src/orchestration/routing/specialist-planner"

const runId = "run-specialist-plan"

function multiDecision() {
  return classifyTask("Fix auth race across API DB UI.")
}

describe("Adaptive specialist planning", () => {
  it("creates no specialist specification for DIRECT mode", () => {
    const plan = buildSpecialistPlan({
      runId,
      goal: "Tell me what Bun version is configured.",
      decision: classifyTask("Tell me what Bun version is configured."),
    })
    expect(plan.executionMode).toBe("DIRECT")
    expect(plan.specs).toEqual([])
  })

  it("creates the smallest required single specialist with inherited model policy", () => {
    const plan = buildSpecialistPlan({
      runId,
      goal: "Delegate this security audit to a specialist.",
      decision: classifyTask("Delegate this security audit to a specialist."),
    })
    expect(plan.executionMode).toBe("SINGLE_SPECIALIST")
    expect(plan.specs).toHaveLength(1)
    expect(plan.specs[0]).toMatchObject({
      capability: "SECURITY",
      targetAgent: "security-auditor",
      required: true,
      modelPolicy: "inherit",
      allowedTools: ["glob", "grep", "read"],
    })
  })

  it("deduplicates equivalent candidates and applies a configurable fan-out bound", () => {
    const plan = buildSpecialistPlan({
      runId,
      goal: "Fix auth race across API DB UI.",
      decision: multiDecision(),
      policy: { maxSpecialists: 2 },
      candidates: [
        { id: "debug", capability: "DEBUG", targetAgent: "debug-specialist", scope: ["auth"] },
        { id: "debug-copy", capability: "DEBUG", targetAgent: "debug-specialist", scope: ["auth"] },
        { id: "backend", capability: "BACKEND", targetAgent: "backend-coder", scope: ["session"] },
        { id: "ui", capability: "UI", targetAgent: "frontend-coder", scope: ["login"] },
      ],
    })
    expect(plan.specs).toHaveLength(2)
    expect(plan.deduplicated).toBe(1)
    expect(plan.fanoutBlocked).toBe(1)
  })

  it("keeps dependent specialists blocked until their prerequisite has settled", () => {
    const plan = buildSpecialistPlan({
      runId,
      goal: "Coordinate schema and migration investigation.",
      decision: multiDecision(),
      candidates: [
        { id: "schema", capability: "BACKEND", targetAgent: "backend-coder", scope: ["schema"] },
        { id: "migration", capability: "DEBUG", targetAgent: "debug-specialist", scope: ["migration"], dependsOn: ["schema"] },
      ],
    })
    expect(readySpecialistSpecs(plan, new Set()).map(spec => spec.specialistId)).toEqual(["schema"])
    expect(readySpecialistSpecs(plan, new Set(["schema"])).map(spec => spec.specialistId).sort()).toEqual(["migration", "schema"])
  })

  it("persists explicit optional semantics while ignoring injected specialist model choices", () => {
    const plan = buildSpecialistPlan({
      runId,
      goal: "Inspect UI behaviour.",
      decision: multiDecision(),
      candidates: [
        { id: "ui", capability: "UI", targetAgent: "frontend-coder", objective: "Inspect the login UI state.", required: false, priority: "low", model: "forbidden-model" } as any,
        { id: "backend", capability: "BACKEND", targetAgent: "backend-coder", objective: "Inspect the authentication API.", required: true },
      ],
    })
    expect(plan.specs.find(spec => spec.specialistId === "ui")).toMatchObject({ required: false, priority: "low", modelPolicy: "inherit" })
    expect(plan.specs.find(spec => spec.specialistId === "backend")).toMatchObject({ required: true, modelPolicy: "inherit" })
  })

  it("fails closed on recursive delegation, invalid targets, empty objectives, missing dependencies, and dependency cycles", () => {
    const decision = multiDecision()
    expect(() => buildSpecialistPlan({ runId, goal: "x", decision, callerDepth: 1 })).toThrow("SPECIALIST_RECURSIVE_DELEGATION_DENIED")
    expect(() => buildSpecialistPlan({
      runId,
      goal: "x",
      decision,
      candidates: [{ id: "bad", capability: "DEBUG", targetAgent: "not-a-real-agent" }],
    })).toThrow("SPECIALIST_TARGET_AGENT_INVALID")
    expect(() => buildSpecialistPlan({
      runId,
      goal: "x",
      decision,
      candidates: [
        { id: "debug", capability: "DEBUG", targetAgent: "debug-specialist", objective: "" },
        { id: "backend", capability: "BACKEND", targetAgent: "backend-coder" },
      ],
    })).toThrow("SPECIALIST_OBJECTIVE_EMPTY")
    expect(() => buildSpecialistPlan({
      runId,
      goal: "x",
      decision,
      candidates: [
        { id: "debug", capability: "DEBUG", targetAgent: "debug-specialist", dependsOn: ["missing"] },
        { id: "backend", capability: "BACKEND", targetAgent: "backend-coder" },
      ],
    })).toThrow("SPECIALIST_UNKNOWN_DEPENDENCY")

    const invalidPlan = {
      version: "1.0.0", runId, executionMode: "MULTI_SPECIALIST" as const, reasonCode: "x", deduplicated: 0, fanoutBlocked: 0,
      specs: [
        { specialistId: "one", capability: "DEBUG" as const, role: "debug-specialist", targetAgent: "debug-specialist", objective: "one", scope: ["one"], expectedEvidence: [], dependsOn: ["two"], required: true, priority: "normal" as const, parentRunId: runId, modelPolicy: "inherit" as const },
        { specialistId: "two", capability: "BACKEND" as const, role: "backend-specialist", targetAgent: "backend-coder", objective: "two", scope: ["two"], expectedEvidence: [], dependsOn: ["one"], required: true, priority: "normal" as const, parentRunId: runId, modelPolicy: "inherit" as const },
      ],
    }
    expect(() => assertValidSpecialistPlan(invalidPlan)).toThrow("SPECIALIST_DEPENDENCY_CYCLE")
    expect(parseSpecialistPlan(JSON.stringify(invalidPlan))).toBeNull()

    const toolEscalation = buildSpecialistPlan({
      runId,
      goal: "Inspect security.",
      decision: classifyTask("Delegate this security audit to a specialist."),
    })
    toolEscalation.specs[0].allowedTools = ["write"]
    expect(parseSpecialistPlan(JSON.stringify(toolEscalation))).toBeNull()
  })
})
