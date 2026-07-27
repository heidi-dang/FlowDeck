import { describe, it, expect } from "vitest"
import type { FlowDeckConfig, GovernanceMode } from "@/config/schema"
import { loadFlowDeckConfig, resolveAgentModels } from "@/config/agent-models"

describe("Config Schema & Loader (tests/config/schema.test.ts)", () => {
  it("validates FlowDeckConfig interface structure", () => {
    const mode: GovernanceMode = "strict"
    const config: FlowDeckConfig = {
      maxDelegationDepth: 1,
      maxWritesPerAgent: 15,
      governance: {
        toolGuard: {
          mode,
          blockDangerousOps: true,
        },
      },
    }

    expect(config.maxDelegationDepth).toBe(1)
    expect(config.governance?.toolGuard?.mode).toBe("strict")
  })

  it("loads default configuration when no file exists", () => {
    const config = loadFlowDeckConfig("/nonexistent/directory/path/xyz")
    expect(config).toBeDefined()
    expect(typeof config).toBe("object")
  })

  it("resolves agent models from configuration", () => {
    const models = resolveAgentModels({
      agentModels: {
        heidi: { model: "anthropic/claude-3-5-sonnet-20241022" },
      },
    })

    expect(models.heidi).toBe("anthropic/claude-3-5-sonnet-20241022")
  })
})
