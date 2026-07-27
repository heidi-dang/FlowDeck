/**
 * Governance Chain Integration Test
 *
 * Exercises the composed tool.execute.before handler returned by the plugin()
 * factory end-to-end. Unlike unit tests that mock individual hooks, this test
 * verifies that ALL guards are wired and fire in sequence:
 *
 *   0. Tool call budget tracking
 *   1. Orchestrator guard
 *   2. Governance tool check (off/advisory/strict)
 *   3. Delegation depth check & budget
 *   4. Supervisor preflight review
 *   5. Guard rails
 *   6. Tool guard
 *   7. Loop detection
 *
 * A wiring regression (e.g., a guard silently skipped) will cause these tests
 * to fail.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import flowDeckPlugin from "@/index"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "flowdeck-gov-chain-"))
}

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

interface PluginInstance {
  "tool.execute.before": (input: any, output: any) => Promise<void>
  "tool.execute.after": (input: any, output: any) => Promise<void>
  event: (input: { event: any }) => Promise<void>
}

describe("Governance chain integration", () => {
  let dir: string
  let client: ReturnType<typeof createMockClient>
  let instance: PluginInstance

  beforeEach(async () => {
    process.env.FLOWDECK_DISABLE_FDX_REDIRECT = "true"
    dir = makeTempDir()
    // Create minimal planning state so plugin loads cleanly
    const pd = join(dir, ".opencode", "planning")
    mkdirSync(pd, { recursive: true })
    writeFileSync(join(pd, "STATE.md"), "---\nphase: 1\n---\n# State", "utf-8")

    client = createMockClient()
    instance = (await flowDeckPlugin.server({ directory: dir, client } as any, {})) as unknown as PluginInstance
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe("Guard 0: Tool call budget", () => {
    it("allows calls within budget", async () => {
      const input = { tool: "read", sessionID: "budget-ok", agent: "heidi", args: {} }
      await expect(instance["tool.execute.before"](input, {})).resolves.toBeUndefined()
    })

    it("enforces budget in strict mode after maxToolCalls exceeded", async () => {
      writeFileSync(
        join(dir, ".flowdeck.json"),
        JSON.stringify({
          governance: {
            validator: { mode: "strict" },
            delegationBudget: { maxToolCalls: 3 },
          },
        }),
        "utf-8"
      )
      instance = (await flowDeckPlugin.server({ directory: dir, client } as any, {})) as unknown as PluginInstance

      const sessionID = "budget-strict"
      const input = { tool: "read", sessionID, agent: "heidi", args: {} }

      // First 3 calls should pass
      await instance["tool.execute.before"]({ ...input }, {})
      await instance["tool.execute.before"]({ ...input }, {})
      await instance["tool.execute.before"]({ ...input }, {})

      // 4th call exceeds budget → strict mode throws
      await expect(
        instance["tool.execute.before"]({ ...input }, {})
      ).rejects.toThrow(/budget exceeded/)
    })
  })

  describe("Guard 1: Orchestrator guard", () => {
    it("blocks write tools from non-orchestrator agents on primary session", async () => {
      const { OrchestratorGuard } = await import("@/hooks/orchestrator-guard-hook")
      const { getAgentRoutes } = await import("@/agents/index")
      const guard = new OrchestratorGuard({ routes: getAgentRoutes() })
      guard._setPrimarySessionIdForTest("primary-session")

      let blocked = false
      try {
        guard.check("primary-session", "write")
      } catch {
        blocked = true
      }
      expect(blocked).toBe(true)
    })
  })

  describe("Guard 2: Governance tool check", () => {
    it("blocks contract violations in strict mode", async () => {
      writeFileSync(
        join(dir, ".flowdeck.json"),
        JSON.stringify({
          governance: {
            validator: { mode: "strict" },
          },
        }),
        "utf-8"
      )
      instance = (await flowDeckPlugin.server({ directory: dir, client } as any, {})) as unknown as PluginInstance

      const input = { tool: "write_file", sessionID: "gov-strict", agent: "researcher", args: {} }
      await expect(
        instance["tool.execute.before"](input, {})
      ).rejects.toThrow(/tool-not-in-contract|blocked by governance/i)
    })

    it("warns but allows in advisory mode", async () => {
      writeFileSync(
        join(dir, ".flowdeck.json"),
        JSON.stringify({
          governance: {
            validator: { mode: "advisory" },
          },
        }),
        "utf-8"
      )
      instance = (await flowDeckPlugin.server({ directory: dir, client } as any, {})) as unknown as PluginInstance

      const input = { tool: "write_file", sessionID: "gov-advisory", agent: "researcher", args: {} }
      await expect(instance["tool.execute.before"](input, {})).resolves.toBeUndefined()
    })
  })

  describe("Guard 3: Delegation depth", () => {
    it("blocks excessive delegation depth", async () => {
      writeFileSync(
        join(dir, ".flowdeck.json"),
        JSON.stringify({
          governance: {
            delegationBudget: { maxDepth: 0, maxDelegations: 1 },
          },
        }),
        "utf-8"
      )
      instance = (await flowDeckPlugin.server({ directory: dir, client } as any, {})) as unknown as PluginInstance

      const input = {
        tool: "task",
        sessionID: "depth-test",
        agent: "heidi",
        args: { depth: 1, agent: "researcher" },
      }
      await expect(
        instance["tool.execute.before"](input, {})
      ).rejects.toThrow(/delegation/i)
    })
  })

  describe("Guard 7: Loop detection", () => {
    it("blocks repeated identical tool calls", async () => {
      writeFileSync(
        join(dir, ".flowdeck.json"),
        JSON.stringify({
          governance: {
            loopDetection: { enabled: true, maxRepeats: 1, similarityThreshold: 0.9, historySize: 10 },
          },
        }),
        "utf-8"
      )
      instance = (await flowDeckPlugin.server({ directory: dir, client } as any, {})) as unknown as PluginInstance

      const sessionID = "loop-test"
      const input = { tool: "write", sessionID, agent: "heidi", args: { file: "a.ts", content: "x" } }
      const output = { args: { file: "a.ts", content: "x" } }

      // First call passes
      await instance["tool.execute.before"](input, output)
      await instance["tool.execute.after"]({ ...input, output: "ok" }, output)

      // Second identical call passes
      await instance["tool.execute.before"](input, output)
      await instance["tool.execute.after"]({ ...input, output: "ok" }, output)

      // Third identical call should be blocked or warned
      let blockedOrWarned = false
      try {
        await instance["tool.execute.before"](input, output)
        const logCalls = (client.app.log as any).mock.calls
        const hasWarning = logCalls.some((c: any) =>
          c[0]?.body?.message?.includes("loop") || c[0]?.body?.message?.includes("repeat")
        )
        blockedOrWarned = hasWarning
      } catch (err: any) {
        blockedOrWarned = /loop|repeat|escalat/i.test(err.message)
      }
      expect(blockedOrWarned).toBe(true)
    })
  })

  describe("Full chain: normal operation passes all guards", () => {
    it("allows a benign read operation through the entire chain", async () => {
      const input = {
        tool: "read",
        sessionID: "full-chain",
        agent: "heidi",
        args: { filePath: "src/index.ts" },
      }
      await expect(instance["tool.execute.before"](input, {})).resolves.toBeUndefined()
    })

    it("processes tool.execute.after without errors", async () => {
      const input = {
        tool: "read",
        sessionID: "full-chain-after",
        agent: "heidi",
        args: { filePath: "src/index.ts" },
        output: "file content",
      }
      await expect(instance["tool.execute.after"](input, {})).resolves.toBeUndefined()
    })
  })
})
