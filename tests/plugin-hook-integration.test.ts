import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import flowDeckPlugin, { cleanupSessionState } from "../src/index"
import { validateToolAccess } from "../src/services/agent-validator"
import { auditLogPath } from "../src/services/audit-log"
import { getAgentConfigs } from "../src/agents/index"

import { writeFileSync } from "node:fs"

function createTmpDir(): string {
  const dir = join(tmpdir(), `fd-test-plugin-hook-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict", validator: { mode: "strict" } } }))
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
    const sessionID = "ses_parent_1"
    const callID = "call-task-101"

    // 1. Establish parent session via event
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: {
          info: { id: sessionID, agent: "heidi" },
        },
      },
    })

    // 2. Establish session caller agent via chat.message hook
    await pluginInstance["chat.message"](
      { sessionID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    // 3. Execute before hook using OpenCode's real (toolInput, toolOutput) signature
    const toolInput = { tool: "task", sessionID, callID, args: {} }
    const toolOutput = { args: { subagent_type: "security-auditor", prompt: "Audit auth" } }

    await expect(pluginInstance["tool.execute.before"](toolInput, toolOutput)).resolves.toBeUndefined()

    // 4. Verify audit log contains delegation.started with callID, targetAgent, and promptSnippet
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

  it("emits delegation.completed with durationMs on successful after-hook matching exact OpenCode result shape", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const sessionID = "ses_parent_2"
    const callID = "call-task-102"

    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: {
          info: { id: sessionID, agent: "heidi" },
        },
      },
    })

    await pluginInstance["chat.message"](
      { sessionID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    const toolInputBefore = { tool: "task", sessionID, callID, args: {} }
    const toolOutputBefore = { args: { subagent_type: "tester", prompt: "Write test suite", description: "Test work" } }

    await pluginInstance["tool.execute.before"](toolInputBefore, toolOutputBefore)

    // Simulate task completion in after hook with exact OpenCode result shape
    const afterInput = {
      tool: "task",
      sessionID,
      callID,
      args: {
        subagent_type: "tester",
        prompt: "Write test suite",
        description: "Test work",
      },
    }
    const afterOutput = {
      title: "Test work",
      output: "Tests created successfully",
      metadata: {},
    }
    await pluginInstance["tool.execute.after"](afterInput, afterOutput)

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
    const sessionID = "ses_parent_3"
    const callID = "call-task-103"

    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: {
          info: { id: sessionID, agent: "heidi" },
        },
      },
    })

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

  it("allows specialist child session chat.message via parentID and blocks nested delegation by resolved caller agent", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const parentID = "ses_parent_real"
    const childID = "ses_child_real"
    const callID = "call-task-nested"

    // 1. Parent session created
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: {
          info: { id: parentID, agent: "heidi" },
        },
      },
    })

    // 2. Child session created with parentID pointing to parent session
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: childID,
            parentID,
            agent: "backend-coder",
          },
        },
      },
    })

    // 3. Specialist child's chat.message MUST be allowed because parentID exists
    await expect(
      pluginInstance["chat.message"](
        { sessionID: childID, agent: "backend-coder" },
        { message: { agent: "backend-coder", system: "" } as any },
      ),
    ).resolves.toBeUndefined()

    // 4. Specialist child attempts to invoke Task tool — MUST be rejected as nested delegation from specialist caller
    const toolInput = { tool: "task", sessionID: childID, callID, args: {} }
    const toolOutput = { args: { subagent_type: "tester", prompt: "Nested task" } }

    await expect(pluginInstance["tool.execute.before"](toolInput, toolOutput)).rejects.toThrow(
      /tool-not-in-contract|SPECIALIST_CANNOT_DELEGATE/,
    )
  })

  it("fails closed with TASK_CALLER_UNRESOLVED in strict mode when caller cannot be resolved", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const sessionID = "ses_unknown_caller"
    const callID = "call-task-unresolved"

    // No session event or chat.message registration — session caller is unknown
    const toolInput = { tool: "task", sessionID, callID, args: {} }
    const toolOutput = { args: { subagent_type: "tester", prompt: "Task from unknown caller" } }

    // In strict mode (default), MUST reject with TASK_CALLER_UNRESOLVED
    await expect(pluginInstance["tool.execute.before"](toolInput, toolOutput)).rejects.toThrow(
      /TASK_CALLER_UNRESOLVED/,
    )
  })

  it("clears sessionTaskCalls and sessionRegistry during cleanupSessionState", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const sessionID = "ses_cleanup_test"
    const callID = "call-task-clean"

    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: {
          info: { id: sessionID, agent: "heidi" },
        },
      },
    })

    await pluginInstance["chat.message"](
      { sessionID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    const toolInput = { tool: "task", sessionID, callID, args: {} }
    const toolOutput = { args: { subagent_type: "tester", prompt: "Clean task" } }

    await pluginInstance["tool.execute.before"](toolInput, toolOutput)

    // Run cleanup
    cleanupSessionState(sessionID)

    // Re-running after-hook should find no active task record
    const afterInput = { tool: "task", sessionID, callID, args: { subagent_type: "tester" } }
    const afterOutput = { title: "Clean task", output: "Done", metadata: {} }

    // after-hook completes gracefully without error even if state was cleaned up
    await expect(pluginInstance["tool.execute.after"](afterInput, afterOutput)).resolves.toBeUndefined()
  })

  it("continues through remaining governance hooks when task call has no targetAgent", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const sessionID = "ses_integration_5"
    const callID = "call-task-105"

    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: {
          info: { id: sessionID, agent: "heidi" },
        },
      },
    })

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
