import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import flowDeckPlugin from "../src/index"
import { validateToolAccess } from "../src/services/agent-validator"
import { auditLogPath } from "../src/services/audit-log"
import { getAgentConfigs } from "../src/agents/index"

function createTmpDir(): string {
  const dir = join(tmpdir(), `fd-test-plugin-hook-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("Plugin Hook Integration — Real OpenCode Contract", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTmpDir()
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  it("allows heidi to delegate using toolOutput.args schema and records delegation.started", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const sessionID = "sess-integration-1"
    const callID = "call-task-101"

    // 1. Establish session caller agent via chat.message hook
    if (pluginInstance["chat.message"]) {
      await pluginInstance["chat.message"](
        { sessionID, agent: "heidi" },
        { message: { agent: "heidi", system: "" } as any },
      )
    }

    // 2. Execute before hook using OpenCode's real (toolInput, toolOutput) signature
    const toolInput = { tool: "task", sessionID, callID, args: {} }
    const toolOutput = { args: { subagent_type: "security-auditor", prompt: "Audit auth" } }

    if (pluginInstance["tool.execute.before"]) {
      await expect(pluginInstance["tool.execute.before"](toolInput, toolOutput)).resolves.toBeUndefined()
    }

    // 3. Verify audit log contains delegation.started with callID, targetAgent, and promptSnippet
    const auditFile = auditLogPath(tmpDir)
    expect(existsSync(auditFile)).toBe(true)

    const lines = readFileSync(auditFile, "utf-8").trim().split("\n")
    const startedEvent = lines.map(l => JSON.parse(l)).find(e => e.kind === "delegation.started")

    expect(startedEvent).toBeDefined()
    expect(startedEvent.agent).toBe("heidi")
    expect(startedEvent.details.callID).toBe(callID)
    expect(startedEvent.details.targetAgent).toBe("security-auditor")
    expect(startedEvent.details.resolvedFrom).toBe("subagent_type")
    expect(startedEvent.details.promptLength).toBe("Audit auth".length)
    expect(startedEvent.details.promptSnippet).toBe("Audit auth")
  })

  it("emits delegation.completed with durationMs on successful after-hook", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const sessionID = "sess-integration-2"
    const callID = "call-task-102"

    await pluginInstance["chat.message"](
      { sessionID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    const toolInput = { tool: "task", sessionID, callID, args: {} }
    const toolOutputBefore = { args: { subagent_type: "tester", prompt: "Write test suite" } }

    await pluginInstance["tool.execute.before"](toolInput, toolOutputBefore)

    // Simulate task completion in after hook
    const toolOutputAfter = { args: { subagent_type: "tester" }, output: "Tests created successfully" }
    await pluginInstance["tool.execute.after"](toolInput, toolOutputAfter)

    const lines = readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n")
    const completedEvent = lines.map(l => JSON.parse(l)).find(e => e.kind === "delegation.completed")

    expect(completedEvent).toBeDefined()
    expect(completedEvent.agent).toBe("heidi")
    expect(completedEvent.details.callID).toBe(callID)
    expect(completedEvent.details.targetAgent).toBe("tester")
    expect(typeof completedEvent.details.durationMs).toBe("number")
    expect(completedEvent.details.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("emits delegation.failed when after-hook receives null/error result", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const sessionID = "sess-integration-3"
    const callID = "call-task-103"

    await pluginInstance["chat.message"](
      { sessionID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    const toolInput = { tool: "task", sessionID, callID, args: {} }
    const toolOutputBefore = { args: { subagent_type: "backend-coder", prompt: "Failing task" } }

    await pluginInstance["tool.execute.before"](toolInput, toolOutputBefore)

    // Simulate task failure (toolInput error or null toolOutput)
    const failedInput = { tool: "task", sessionID, callID, args: {}, error: "Subagent process crashed" }
    await pluginInstance["tool.execute.after"](failedInput, null)

    const lines = readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n")
    const failedEvent = lines.map(l => JSON.parse(l)).find(e => e.kind === "delegation.failed")

    expect(failedEvent).toBeDefined()
    expect(failedEvent.agent).toBe("heidi")
    expect(failedEvent.details.callID).toBe(callID)
    expect(failedEvent.details.targetAgent).toBe("backend-coder")
    expect(failedEvent.reason).toContain("Subagent process crashed")
  })

  it("blocks specialist subagent caller from delegating even without toolInput.agent", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const sessionID = "sub-sess-integration-4"
    const callID = "call-task-104"

    // toolInput does NOT state agent (real OpenCode signature)
    const toolInput = { tool: "task", sessionID, callID, args: {} }
    const toolOutput = { args: { subagent_type: "tester", prompt: "Delegate to tester" } }

    await expect(pluginInstance["tool.execute.before"](toolInput, toolOutput)).rejects.toThrow()
  })

  it("continues through remaining governance hooks when task call has no targetAgent", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const sessionID = "sess-integration-5"
    const callID = "call-task-105"

    await pluginInstance["chat.message"](
      { sessionID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    // Non-delegation task tool call (empty subagent_type)
    const toolInput = { tool: "task", sessionID, callID, args: {} }
    const toolOutput = { args: { subagent_type: "", command: "ls" } }

    // Should NOT throw and should NOT short-circuit
    await expect(pluginInstance["tool.execute.before"](toolInput, toolOutput)).resolves.toBeUndefined()
  })

  it("permits hash-edit for heidi in strict governance mode", () => {
    const access = validateToolAccess(tmpDir, "heidi", "hash-edit")
    expect(access.action).toBe("allow")
    expect(access.valid).toBe(true)
  })

  it("exports permission.task config in getAgentConfigs for SDK enforcement", () => {
    const configs = getAgentConfigs()

    // Heidi has subagent task allowlist
    const heidiTaskPerm = (configs.heidi as any)?.permission?.task
    expect(heidiTaskPerm).toBeDefined()
    expect(heidiTaskPerm["*"]).toBe("deny")
    expect(heidiTaskPerm["backend-coder"]).toBe("allow")
    expect(heidiTaskPerm["security-auditor"]).toBe("allow")

    // Specialist has task: "deny"
    const specialistTaskPerm = (configs["backend-coder"] as any)?.permission?.task
    expect(specialistTaskPerm).toBe("deny")
  })
})
