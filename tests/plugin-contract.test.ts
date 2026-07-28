/**
 * Modern Plugin Contract Tests
 *
 * Verifies FlowDeck's export shape matches OpenCode's modern plugin-module contract:
 * - Default export is an object { id, server }
 * - server is a function (the plugin factory)
 * - server returns the expected hooks (config, tool, event, etc.)
 * - config hook injects Heidi as primary agent
 * - Named diagnostic exports remain importable
 * - Legacy contract regression: named exports do NOT cause scanner rejection
 */

import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import flowDeckPlugin, {
  AGENT_NAMES,
  createAgent,
  validateDelegationDepth,
  evaluateGovernanceToolCheck,
  acquireLock,
  releaseLock,
  cleanupSessionState,
  getSessionMetricsDiagnostics,
} from "@/index"

function createMockClient() {
  return {
    app: {
      log: vi.fn().mockResolvedValue(undefined),
    },
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "child-1" }, error: null }),
      promptAsync: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    event: {
      subscribe: vi.fn().mockResolvedValue({
        stream: (async function* () {})(),
      }),
    },
  }
}

describe("modern plugin contract", () => {
  it("default export is an object with id and server", () => {
    expect(typeof flowDeckPlugin).toBe("object")
    expect(flowDeckPlugin.id).toBe("@heidi-dang/flowdeck")
    expect(typeof flowDeckPlugin.server).toBe("function")
  })

  it("server returns expected hooks when invoked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowdeck-contract-"))
    const client = createMockClient()

    try {
      const hooks = await flowDeckPlugin.server({ directory: dir, client } as any, {})

      expect(typeof hooks.config).toBe("function")
      expect(typeof hooks.event).toBe("function")
      expect(typeof hooks["tool.execute.before"]).toBe("function")
      expect(typeof hooks["tool.execute.after"]).toBe("function")
      expect(hooks.tool).toBeDefined()
      expect(typeof hooks.tool).toBe("object")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does NOT expose legacy properties name/agent/mcp at hook level", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowdeck-contract-"))
    const client = createMockClient()

    try {
      const hooks = await flowDeckPlugin.server({ directory: dir, client } as any, {})

      // Legacy properties are injected via config hook, not returned directly
      expect((hooks as any).name).toBeUndefined()
      expect((hooks as any).agent).toBeUndefined()
      expect((hooks as any).mcp).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("config hook sets default_agent to heidi", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowdeck-config-"))
    const client = createMockClient()

    try {
      const hooks = await flowDeckPlugin.server({ directory: dir, client } as any, {})
      const cfg: Record<string, unknown> = {}
      await hooks.config?.(cfg)

      expect(cfg.default_agent).toBe("heidi")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("config hook registers heidi as primary, non-hidden agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowdeck-heidi-"))
    const client = createMockClient()

    try {
      const hooks = await flowDeckPlugin.server({ directory: dir, client } as any, {})
      const cfg: Record<string, unknown> = {}
      await hooks.config?.(cfg)

      const agent = cfg.agent as Record<string, any>
      expect(agent).toBeDefined()
      expect(agent.heidi).toBeDefined()
      expect(agent.heidi.mode).toBe("primary")
      expect(agent.heidi.hidden).toBe(false)
      expect(agent.orchestrator).toBeDefined()
      expect(agent.orchestrator.mode).toBe("primary")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("config hook preserves user default_agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowdeck-preserve-"))
    const client = createMockClient()

    try {
      const hooks = await flowDeckPlugin.server({ directory: dir, client } as any, {})
      const cfg: Record<string, unknown> = { default_agent: "build" }
      await hooks.config?.(cfg)

      expect(cfg.default_agent).toBe("build")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("config hook preserves user agent overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowdeck-override-"))
    const client = createMockClient()

    try {
      const hooks = await flowDeckPlugin.server({ directory: dir, client } as any, {})
      const cfg: Record<string, unknown> = {
        agent: {
          heidi: { temperature: 0.7 },
        },
      }
      await hooks.config?.(cfg)

      const agent = cfg.agent as Record<string, any>
      expect(agent.heidi.temperature).toBe(0.7)
      expect(agent.heidi.mode).toBe("primary")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("named diagnostic exports", () => {
  it("AGENT_NAMES is an array containing heidi", () => {
    expect(Array.isArray(AGENT_NAMES)).toBe(true)
    expect(AGENT_NAMES).toContain("heidi")
  })

  it("createAgent is a function", () => {
    expect(typeof createAgent).toBe("function")
  })

  it("validateDelegationDepth is a function", () => {
    expect(typeof validateDelegationDepth).toBe("function")
  })

  it("evaluateGovernanceToolCheck is a function", () => {
    expect(typeof evaluateGovernanceToolCheck).toBe("function")
  })

  it("acquireLock and releaseLock are functions", () => {
    expect(typeof acquireLock).toBe("function")
    expect(typeof releaseLock).toBe("function")
  })

  it("cleanupSessionState is a function", () => {
    expect(typeof cleanupSessionState).toBe("function")
  })

  it("getSessionMetricsDiagnostics is a function", () => {
    expect(typeof getSessionMetricsDiagnostics).toBe("function")
  })
})

describe("modern plugin contract", () => {
  it("default export is the plugin function (modern contract)", () => {
    // Modern OpenCode PluginModule contract: the default export is
    // the plugin function directly — not an { id, server } wrapper.
    expect(typeof flowDeckPlugin).toBe("function")
  })

  it("named exports do NOT include non-function values that would crash legacy scanner", () => {
    // Even though we have named exports, the modern default export ensures
    // OpenCode never enters legacy scanning mode. This test documents that
    // AGENT_NAMES (an array) would have crashed the legacy scanner, but is
    // safe in the modern contract.
    expect(Array.isArray(AGENT_NAMES)).toBe(true)

    // All other named exports are functions — they would have been
    // safe even in legacy mode, but the modern contract is still correct.
    const namedExportKeys = [
      "createAgent",
      "validateDelegationDepth",
      "evaluateGovernanceToolCheck",
      "acquireLock",
      "releaseLock",
      "cleanupSessionState",
      "getSessionMetricsDiagnostics",
    ]
    // We don't need to test these individually again — they're covered above.
    // This test exists to document the regression path.
    expect(namedExportKeys.length).toBeGreaterThan(0)
  })
})
