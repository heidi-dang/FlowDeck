import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "os"
import { join } from "path"
import { mkdirSync, rmSync } from "fs"
import flowDeckPlugin, { cleanupSessionState } from "../src/index"
import { clearToolErrorCounts } from "../src/services/orchestrator-guard-strategy-circuit"

describe("Repeated Tool Error Circuit Breaker Lifecycle", () => {
  const testDir = join(tmpdir(), "tool-error-circuit-" + Date.now())
  let pluginInstance: any

  beforeEach(async () => {
    mkdirSync(testDir, { recursive: true })
    pluginInstance = await (flowDeckPlugin as any).server({
      directory: testDir,
      client: { app: { log: async () => {} } } as any,
    })
  })

  afterEach(async () => {
    if (pluginInstance?.dispose) await pluginInstance.dispose()
    try { rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it("trips circuit breaker after 3 identical tool execution failures", async () => {
    const sessionID = "sess-err-circuit-1"
    clearToolErrorCounts(sessionID)

    const beforeHook = pluginInstance["tool.execute.before"]
    const afterHook = pluginInstance["tool.execute.after"]
    const toolName = "custom_tool"
    const rawArgs = { param: "fail_payload" }

    // Attempt 1: before allows, tool fails in after
    await beforeHook({ sessionID, tool: toolName, args: rawArgs }, {})
    await afterHook({ sessionID, tool: toolName, args: rawArgs, error: new Error("Execution failure 500") }, {})

    // Attempt 2: before allows, tool fails in after
    await beforeHook({ sessionID, tool: toolName, args: rawArgs }, {})
    await afterHook({ sessionID, tool: toolName, args: rawArgs, error: new Error("Execution failure 500") }, {})

    // Attempt 3: 3rd identical attempt MUST be blocked by circuit breaker
    let threw = false
    try {
      await beforeHook({ sessionID, tool: toolName, args: rawArgs }, {})
    } catch (err: any) {
      threw = true
      expect(err.message).toContain("Circuit breaker open")
      expect(err.code).toBe("TOOL_ERROR_CIRCUIT_OPEN")
    }
    expect(threw).toBe(true)
  })

  it("allows same tool with different arguments when previous args tripped circuit", async () => {
    const sessionID = "sess-err-circuit-2"
    clearToolErrorCounts(sessionID)

    const beforeHook = pluginInstance["tool.execute.before"]
    const afterHook = pluginInstance["tool.execute.after"]
    const toolName = "custom_tool"

    // Fail with arg1
    await beforeHook({ sessionID, tool: toolName, args: { file: "bad.txt" } }, {})
    await afterHook({ sessionID, tool: toolName, args: { file: "bad.txt" }, error: new Error("Not found") }, {})

    await beforeHook({ sessionID, tool: toolName, args: { file: "bad.txt" } }, {})
    await afterHook({ sessionID, tool: toolName, args: { file: "bad.txt" }, error: new Error("Not found") }, {})

    // Attempt with different arg2 should NOT be blocked
    let threw = false
    try {
      await beforeHook({ sessionID, tool: toolName, args: { file: "good.txt" } }, {})
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })

  it("clears circuit breaker on cleanupSessionState", async () => {
    const sessionID = "sess-err-circuit-3"
    clearToolErrorCounts(sessionID)

    const beforeHook = pluginInstance["tool.execute.before"]
    const afterHook = pluginInstance["tool.execute.after"]
    const toolName = "custom_tool"
    const rawArgs = { cmd: "test" }

    // Fail with rawArgs
    await beforeHook({ sessionID, tool: toolName, args: rawArgs }, {})
    await afterHook({ sessionID, tool: toolName, args: rawArgs, error: new Error("Fail") }, {})

    await beforeHook({ sessionID, tool: toolName, args: rawArgs }, {})
    await afterHook({ sessionID, tool: toolName, args: rawArgs, error: new Error("Fail") }, {})

    // Before hook now blocks
    await expect(beforeHook({ sessionID, tool: toolName, args: rawArgs }, {})).rejects.toThrow("Circuit breaker open")

    // Clean up session
    cleanupSessionState(sessionID)

    // After session cleanup, before hook allows again
    let threw = false
    try {
      await beforeHook({ sessionID, tool: toolName, args: rawArgs }, {})
    } catch (err: any) {
      console.log("Post cleanup error:", err.message, err.code, err.name)
      threw = true
    }
    expect(threw).toBe(false)
  })
})
