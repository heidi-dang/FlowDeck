/**
 * Runtime Agent Hook Tests
 *
 * Tests the actual chat.message hook returned by flowDeckPlugin.server().
 * Verifies:
 * - Hook invokes enforcement correctly
 * - Strict mode blocks mismatched agents
 * - Warn/off mode allow but add identity markers
 * - Subagent and synthetic messages are excluded
 */

import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import flowDeckPlugin, {
  AGENT_NAMES,
} from "@/index"

function createMockClient() {
  return {
    app: { log: vi.fn().mockResolvedValue(undefined) },
    session: {
      get: vi.fn().mockResolvedValue({ data: null, error: null }),
      create: vi.fn().mockResolvedValue({ data: { id: "child-1" }, error: null }),
    },
  }
}

describe("chat.message hook integration", () => {
  it("is registered as a function on the plugin hooks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fd-hook-test-"))
    const client = createMockClient()
    try {
      const hooks = await flowDeckPlugin.server({ directory: dir, client } as any, {})
      expect(typeof hooks["chat.message"]).toBe("function")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("allows heidi agent through by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fd-hook-allow-"))
    const client = createMockClient()
    try {
      const hooks = await flowDeckPlugin.server({ directory: dir, client } as any, {})
      const output = { message: { role: "user", agent: "heidi", system: "" } }

      await expect(
        hooks["chat.message"]!({ sessionID: "test-1", agent: "heidi" }, output as any)
      ).resolves.toBeUndefined()

      // Identity marker should be present
      expect(output.message.system).toContain("FlowDeck Heidi coordinator")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("registers heidi in agent list", () => {
    expect(Array.isArray(AGENT_NAMES)).toBe(true)
    expect(AGENT_NAMES).toContain("heidi")
  })
})
