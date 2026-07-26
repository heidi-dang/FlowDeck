import { describe, it, expect } from "vitest"
import { createAgent, createAgents, getAgentConfigs, AGENT_NAMES } from "@/agents/index"
import { createHeidiAgent, createOrchestratorAgent } from "@/agents/orchestrator"
import {
  EXECUTION_STRATEGIES,
  isValidExecutionStrategy,
  LIFECYCLE_STAGES,
  evaluateDelegationJustification,
  performSurfaceAreaCheck,
  BoundedRecoveryTracker,
} from "@/services/heidi-execution-policy"

describe("Phase 2 — Heidi Primary Execution Policy", () => {
  describe("1. Agent Identity & Alias", () => {
    it("registers heidi in AGENT_NAMES", () => {
      expect(AGENT_NAMES).toContain("heidi")
      expect(AGENT_NAMES).toContain("orchestrator")
    })

    it("creates heidi agent with primary mode", () => {
      const agent = createHeidiAgent()
      expect(agent.name).toBe("heidi")
      expect(agent.config.prompt).toContain("Heidi")
    })

    it("creates orchestrator alias using same underlying factory", () => {
      const orch = createOrchestratorAgent()
      expect(orch.name).toBe("orchestrator")
      expect(orch.config.prompt).toContain("Heidi")
    })

    it("getAgentConfigs marks both heidi and orchestrator as primary", () => {
      const configs = getAgentConfigs()
      expect(configs["heidi"]?.mode).toBe("primary")
      expect(configs["orchestrator"]?.mode).toBe("primary")
    })
  })

  describe("2. Execution Strategies", () => {
    it("defines 8 execution strategies", () => {
      expect(EXECUTION_STRATEGIES).toEqual([
        "fast_direct",
        "direct",
        "explore_then_direct",
        "planner_then_execute",
        "debugger_root_cause",
        "frontend_backend_parallel",
        "audit_only",
        "audit_after_change",
      ])
    })

    it("validates valid and invalid strategy names", () => {
      expect(isValidExecutionStrategy("direct")).toBe(true)
      expect(isValidExecutionStrategy("fast_direct")).toBe(true)
      expect(isValidExecutionStrategy("unknown_strategy")).toBe(false)
    })
  })

  describe("3. Delegation Justification Policy", () => {
    it("rejects delegation when no justification condition is met", () => {
      const res = evaluateDelegationJustification({})
      expect(res.justified).toBe(false)
      expect(res.reasons).toHaveLength(0)
    })

    it("allows delegation when explicit user request is provided", () => {
      const res = evaluateDelegationJustification({ explicitUserRequest: true })
      expect(res.justified).toBe(true)
      expect(res.reasons[0]).toContain("explicitly requested")
    })

    it("allows delegation for independent non-overlapping work", () => {
      const res = evaluateDelegationJustification({ independentOwnership: true })
      expect(res.justified).toBe(true)
    })

    it("allows delegation for specialized domain requirement", () => {
      const res = evaluateDelegationJustification({ specialistDomainRequired: true })
      expect(res.justified).toBe(true)
    })

    it("allows delegation for audit/security review", () => {
      const res = evaluateDelegationJustification({ auditOrSecurityReview: true })
      expect(res.justified).toBe(true)
    })

    it("allows delegation when direct discovery failed", () => {
      const res = evaluateDelegationJustification({ directDiscoveryFailed: true })
      expect(res.justified).toBe(true)
    })

    it("allows delegation when change spans multiple domains", () => {
      const res = evaluateDelegationJustification({ multiDomainSpanning: true })
      expect(res.justified).toBe(true)
    })
  })

  describe("4. Six-Stage Lifecycle & Surface-Area Checks", () => {
    it("defines 6 lifecycle stages", () => {
      expect(LIFECYCLE_STAGES).toEqual([
        "intake",
        "route",
        "context",
        "execute",
        "verify",
        "complete",
      ])
    })

    it("performs before-edit surface-area check with real filesystem discovery", () => {
      // The function now performs actual filesystem discovery for dependents,
      // tests, and config — knownDependents/knownTests/knownConfig are no longer
      // used as fallbacks. Pass a real existing file to get meaningful results.
      const res = performSurfaceAreaCheck({
        targetFiles: ["src/index.ts"],
        assumptions: ["Node >= 24"],
        errorPaths: ["EACCES"],
      })

      expect(res.readyForEdit).toBe(true)
      expect(Array.isArray(res.dependents)).toBe(true)
      expect(Array.isArray(res.existingTests)).toBe(true)
      expect(Array.isArray(res.relatedConfig)).toBe(true)
      expect(res.assumptions).toContain("Node >= 24")
      expect(res.errorPaths).toContain("EACCES")
    })
  })

  describe("5. Bounded Recovery Tracker", () => {
    it("enforces 3-stage bounded recovery with circuit breaker", () => {
      const tracker = new BoundedRecoveryTracker()
      const errorKey = "test_failure_1"

      // 1st failure -> targeted_diagnosis
      const step1 = tracker.recordFailure(errorKey)
      expect(step1.action).toBe("targeted_diagnosis")
      expect(step1.attempts).toBe(1)

      // 2nd failure -> change_hypothesis
      const step2 = tracker.recordFailure(errorKey)
      expect(step2.action).toBe("change_hypothesis")
      expect(step2.attempts).toBe(2)

      // 3rd failure -> circuit_breaker_block
      const step3 = tracker.recordFailure(errorKey)
      expect(step3.action).toBe("circuit_breaker_block")
      expect(step3.attempts).toBe(3)
      expect(step3.message).toContain("Circuit Breaker")
    })
  })
})
