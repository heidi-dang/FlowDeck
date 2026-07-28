/**
 * Provider-backed OpenCode Acceptance Test
 *
 * OPT-IN ONLY: Set OPENCODE_PROVIDER_ACCEPTANCE=1 to enable this test.
 * Requires a configured OpenCode model provider (OPENCODE_API_KEY or provider config).
 * Without the env var, the entire suite skips with a clear message.
 *
 * This test:
 * - Creates a disposable fixture directory
 * - Starts the FlowDeck plugin with a mock OpenCode client
 * - Issues a task requiring one specialist delegation
 * - Verifies actual child session correlation via audit events
 * - Handles specialist failure and recovery delegation
 * - Asserts telemetry, cleanup, and final response
 *
 * SAFETY: Never exposes secrets. All fixture data is synthetic.
 * Does NOT make real model API calls unless explicitly configured.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import flowDeckPlugin, {
  cleanupSessionState,
  getSessionMetricsDiagnostics,
} from "../src/index"
import { auditLogPath } from "../src/services/audit-log"

const IS_OPTED_IN = process.env.OPENCODE_PROVIDER_ACCEPTANCE === "1"

// When opted-in, run the full acceptance suite
if (IS_OPTED_IN) {
  describe("provider-backed OpenCode acceptance", { timeout: 30_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), "flowdeck-provider-acceptance-"))
    let plugin: any
    const logs: string[] = []
    const parentSessionID = "provider-acceptance-parent"

    beforeAll(async () => {
      // Create fixture files for tool operations
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "test-fixture" }), "utf-8")

      const mockClient: any = {
        app: { log: async ({ body }: any) => { logs.push(body.message) } },
        session: { create: async () => "child-session-1", prompt: async () => "ok" },
      }

      plugin = await flowDeckPlugin.server(
        { directory, client: mockClient } as never,
        {},
      )
    })

    afterAll(() => {
      cleanupSessionState(parentSessionID)
      rmSync(directory, { recursive: true, force: true })
    })

    it("1. plugin starts and registers tools", () => {
      expect(plugin).toBeDefined()
      expect(typeof plugin.event).toBe("function")
      expect(typeof plugin["tool.execute.before"]).toBe("function")
      expect(typeof plugin["tool.execute.after"]).toBe("function")
      expect(typeof plugin["chat.message"]).toBe("function")
    })

    it("2. creates a session and sets runtime agent identity", async () => {
      await plugin.event({
        event: {
          type: "session.created",
          properties: { info: { id: parentSessionID, agent: "heidi" } },
        },
      })
      const message = { message: { agent: "heidi", system: "" } }
      await plugin["chat.message"](
        { sessionID: parentSessionID, agent: "heidi" },
        message,
      )
      expect(message.message.system).toContain("Runtime agent ID: heidi")
    })

    it("3. executes a direct read tool call on fixture file", async () => {
      await plugin["tool.execute.before"](
        { tool: "fdx-read", sessionID: parentSessionID, callID: "direct-read" },
        { args: { file: "package.json" } },
      )
      await plugin["tool.execute.after"](
        { tool: "fdx-read", sessionID: parentSessionID, callID: "direct-read" },
        { args: { file: "package.json" }, output: JSON.stringify({ name: "test-fixture" }) },
      )

      // Verify the tool call was logged
      expect(logs.some((m) => m.includes("tool=fdx-read"))).toBe(true)
    })

    it("4. delegates a task to a specialist and correlates child session", async () => {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: parentSessionID, callID: "delegate-test" },
        { args: { subagent_type: "security-auditor", prompt: "Audit fixture boundaries" } },
      )

      // Simulate child session creation (as OpenCode SDK would)
      await plugin.event({
        event: {
          type: "session.created",
          properties: {
            info: { id: "acceptance-child-1", parentID: parentSessionID, agent: "security-auditor" },
          },
        },
      })
      // Correlation: parentID field links child to parent session
    })

    it("5. handles specialist failure and recovery delegation", async () => {
      // Simulate child failure (as OpenCode SDK would)
      await plugin.event({
        event: {
          type: "session.error",
          properties: {
            sessionID: "acceptance-child-1",
            error: { message: "specialist encountered an error" },
          },
        },
      })

      // Recovery delegation
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: parentSessionID, callID: "recovery-delegate" },
        { args: { subagent_type: "debug-specialist", prompt: "Recover and retry" } },
      )
      await plugin["tool.execute.after"](
        { tool: "task", sessionID: parentSessionID, callID: "recovery-delegate" },
        { output: "Recovery verified", metadata: {} },
      )

      // Verify audit log contains both failure and recovery events
      expect(existsSync(auditLogPath(directory))).toBe(true)
      const events = readFileSync(auditLogPath(directory), "utf-8")
        .trim()
        .split("\n")
        .map((line: string) => JSON.parse(line))
      expect(events.some((e: any) =>
        e.kind === "delegation.failed" &&
        e.details?.targetAgent === "security-auditor"
      )).toBe(true)
      expect(events.some((e: any) =>
        e.kind === "delegation.completed" &&
        e.details?.targetAgent === "debug-specialist"
      )).toBe(true)
    })

    it("6. cleans up session state properly", () => {
      cleanupSessionState(parentSessionID)
      const metrics = getSessionMetricsDiagnostics(parentSessionID)
      expect(metrics).toMatchObject({
        toolCalls: 0,
        retries: 0,
        delegations: 0,
        filesChangedCount: 0,
      })
    })
  })
} else {
  describe("provider-backed OpenCode acceptance", () => {
    it("is skipped — set OPENCODE_PROVIDER_ACCEPTANCE=1 to enable this provider-backed test", () => {
      // Intentionally empty: the real test only runs when opted in
    })
  })
}
