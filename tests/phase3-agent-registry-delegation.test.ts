import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AGENT_NAMES, createAgent, createAgents } from "@/agents/index"
import { resolveAgentModels, DEFAULT_CONFIG } from "@/config/agent-models"
import { getAllContracts, getContract, listAgentsWithContracts } from "@/services/agent-contract-registry"
import { toolGuardHook } from "@/hooks/tool-guard"

const TMP = join(tmpdir(), "phase3-test-" + Date.now())

describe("Phase 3 — Agent Registry, Model Inheritance, and Delegation Enforcement", () => {
  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  describe("1. Model Inheritance Logic", () => {
    it("defaults maxDelegationDepth to 1 in DEFAULT_CONFIG", () => {
      expect(DEFAULT_CONFIG.maxDelegationDepth).toBe(1)
    })

    it("inherits user model when per-agent model override is undefined", () => {
      const agent = createAgent("backend-coder")
      expect(agent?.config.model).toBeUndefined()
    })

    it("preserves explicit per-agent model overrides when configured", () => {
      const config = {
        agentModels: { "backend-coder": { model: "claude-3-5-sonnet" } },
      }
      const models = resolveAgentModels(config)
      expect(models["backend-coder"]).toBe("claude-3-5-sonnet")

      const agent = createAgent("backend-coder", models["backend-coder"])
      expect(agent?.config.model).toBe("claude-3-5-sonnet")
    })

    it("does not inject hardcoded default model when override is absent", () => {
      const agents = createAgents()
      for (const agent of agents) {
        expect(agent.config.model).toBeUndefined()
      }
    })
  })

  describe("2. Delegation Depth Enforcement (Depth = 1)", () => {
    it("allows primary agents (heidi / orchestrator) to invoke task tool with subagent_type schema", async () => {
      process.env.FLOWDECK_TOOL_GUARD_ENABLED = "on"
      const ctx = { directory: TMP, agent: "heidi" }
      const input = { tool: "task", sessionID: "s1-sub" }
      const output = { args: { subagent_type: "backend-coder", prompt: "Build feature" } }

      await expect(toolGuardHook(ctx, input, output)).resolves.toBeUndefined()
    })

    it("blocks subagents from spawning nested subagents via task tool with subagent_type schema", async () => {
      process.env.FLOWDECK_TOOL_GUARD_ENABLED = "on"
      const ctx = { directory: TMP, agent: "backend-coder" }
      const input = { tool: "task", sessionID: "s2-sub" }
      const output = { args: { subagent_type: "tester", prompt: "Write test" } }

      await expect(toolGuardHook(ctx, input, output)).rejects.toThrow(/Delegation depth limit reached/)
    })
  })

  describe("3. Agent Capability Contracts Audit", () => {
    it("covers all 14 registered agents in AGENT_NAMES", () => {
      const registered = listAgentsWithContracts()
      expect(registered).toHaveLength(14)
      for (const name of AGENT_NAMES) {
        expect(registered).toContain(name)
      }
    })

    it("verifies every contract has all required policy fields", () => {
      const contracts = getAllContracts()
      expect(contracts).toHaveLength(14)

      for (const c of contracts) {
        expect(c.agent, `Missing agent name in contract`).toBeTruthy()
        expect(c.role, `Missing role in contract for ${c.agent}`).toBeTruthy()
        expect(c.allowedTaskTypes.length, `Empty allowedTaskTypes for ${c.agent}`).toBeGreaterThan(0)
        expect(c.requiredInputs.length, `Empty requiredInputs for ${c.agent}`).toBeGreaterThan(0)
        expect(c.expectedOutputFields.length, `Empty expectedOutputFields for ${c.agent}`).toBeGreaterThan(0)
        expect(c.allowedTools.length, `Empty allowedTools for ${c.agent}`).toBeGreaterThan(0)
        expect(c.forbiddenActions.length, `Empty forbiddenActions for ${c.agent}`).toBeGreaterThan(0)
        expect(c.escalationConditions.length, `Empty escalationConditions for ${c.agent}`).toBeGreaterThan(0)
        expect(c.stopConditions.length, `Empty stopConditions for ${c.agent}`).toBeGreaterThan(0)
        expect(c.successCriteria.length, `Empty successCriteria for ${c.agent}`).toBeGreaterThan(0)
      }
    })

    it("retrieves contracts by agent name", () => {
      expect(getContract("heidi")).not.toBeNull()
      expect(getContract("orchestrator")).not.toBeNull()
      expect(getContract("mapper")).not.toBeNull()
      expect(getContract("unknown-agent")).toBeNull()
    })
  })
})
