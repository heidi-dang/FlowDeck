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

  it("emits delegation.failed when child session fires session.error (real OpenCode failure path)", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const parentSessionID = "ses_parent_3"
    const childSessionID = "ses_child_3"
    const callID = "call-task-103"

    // 1. Parent session created with heidi as caller
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: {
          info: { id: parentSessionID, agent: "heidi" },
        },
      },
    })

    await pluginInstance["chat.message"](
      { sessionID: parentSessionID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    // 2. Heidi delegates to backend-coder via task tool
    const toolInput = { tool: "task", sessionID: parentSessionID, callID, args: {} }
    const toolOutputBefore = { args: { subagent_type: "backend-coder", prompt: "Failing task" } }
    await pluginInstance["tool.execute.before"](toolInput, toolOutputBefore)

    // 3. Child session is created by OpenCode (parentID links it to parent)
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: {
          info: { id: childSessionID, parentID: parentSessionID, agent: "backend-coder" },
        },
      },
    })

    // 4. Child session fails — OpenCode fires session.error on the child, NOT tool.execute.after
    await pluginInstance["event"]({
      event: {
        type: "session.error",
        properties: {
          info: { id: childSessionID, parentID: parentSessionID },
          error: "Subagent process crashed",
        },
      },
    })

    const lines = readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n")
    const failedEvent = lines.map(l => JSON.parse(l)).find(e => e.kind === "delegation.failed")

    expect(failedEvent).toBeDefined()
    expect(failedEvent.agent).toBe("heidi")
    expect(failedEvent.session_id).toBe(parentSessionID)
    expect(failedEvent.details.targetAgent).toBe("backend-coder")
    expect(failedEvent.details.childSessionID).toBe(childSessionID)
    expect(failedEvent.reason).toContain("Subagent process crashed")
  })

  it("handles two concurrent delegations independently without cross-talk on failure", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const parentID = "ses_parent_concurrent"
    const callA = "call-a-backend"
    const callB = "call-b-tester"
    const childA = "ses_child_a"
    const childB = "ses_child_b"

    // 1. Parent session created
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: { info: { id: parentID, agent: "heidi" } },
      },
    })
    await pluginInstance["chat.message"](
      { sessionID: parentID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    // 2. Launch Delegation A (backend-coder)
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callA, args: {} },
      { args: { subagent_type: "backend-coder", prompt: "Build backend" } },
    )
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: { info: { id: childA, parentID, agent: "backend-coder" } },
      },
    })

    // 3. Launch Delegation B (tester)
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callB, args: {} },
      { args: { subagent_type: "tester", prompt: "Run tests" } },
    )
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: { info: { id: childB, parentID, agent: "tester" } },
      },
    })

    // 4. Child B fails with session.error
    await pluginInstance["event"]({
      event: {
        type: "session.error",
        properties: { info: { id: childB, parentID }, error: "Tester process crashed" },
      },
    })

    // Audit check: delegation.failed must exist ONLY for callB / tester
    const lines = readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n")
    const auditEvents = lines.map(l => JSON.parse(l))
    const failedEvents = auditEvents.filter(e => e.kind === "delegation.failed")

    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0].details.targetAgent).toBe("tester")
    expect(failedEvents[0].details.childSessionID).toBe(childB)

    // 5. Delegation A (backend-coder) completes successfully in after-hook
    await pluginInstance["tool.execute.after"](
      { tool: "task", sessionID: parentID, callID: callA, args: { subagent_type: "backend-coder" } },
      { title: "Build backend", output: "Done", metadata: {} },
    )

    const completedEvents = auditEvents.concat(
      readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n").map(l => JSON.parse(l))
    ).filter(e => e.kind === "delegation.completed")

    const completedA = completedEvents.find(e => e.details?.callID === callA)
    expect(completedA).toBeDefined()
    expect(completedA.details.targetAgent).toBe("backend-coder")
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

  // ── Adversarial child-session correlation tests ────────────────────

  it("correlates two concurrent calls to the same target agent (FIFO order)", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const parentID = "ses_same_agent_fifo"
    const callFirst = "call-first"
    const callSecond = "call-second"
    const childFirst = "ses_child_first"
    const childSecond = "ses_child_second"

    // 1. Parent session created
    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: parentID, agent: "heidi" } } },
    })
    await pluginInstance["chat.message"](
      { sessionID: parentID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    // 2. Two concurrent delegations to the SAME target agent (backend-coder)
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callFirst, args: {} },
      { args: { subagent_type: "backend-coder", prompt: "First task" } },
    )
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callSecond, args: {} },
      { args: { subagent_type: "backend-coder", prompt: "Second task" } },
    )

    // 3. First child session created — must correlate to callFirst
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: { info: { id: childFirst, parentID, agent: "backend-coder" } },
      },
    })

    // 4. Second child session created — must correlate to callSecond
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: { info: { id: childSecond, parentID, agent: "backend-coder" } },
      },
    })

    // Verify: first child is correlated to callFirst, second to callSecond
    const { childSessionToTask } = await import("../src/index")
    const corr1 = childSessionToTask.get(childFirst)
    const corr2 = childSessionToTask.get(childSecond)
    expect(corr1).toBeDefined()
    expect(corr2).toBeDefined()
    expect(corr1!.callID).toBe(callFirst)
    expect(corr2!.callID).toBe(callSecond)
    expect(corr1!.taskKey).toContain(callFirst)
    expect(corr2!.taskKey).toContain(callSecond)
    expect(corr1!.targetAgent).toBe("backend-coder")
    expect(corr2!.targetAgent).toBe("backend-coder")

    // First child fails — only its task call should be cleaned up
    await pluginInstance["event"]({
      event: {
        type: "session.error",
        properties: { info: { id: childFirst, parentID }, error: "First child crashed" },
      },
    })

    const auditLines = readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n")
    const failedEvents = auditLines.map(l => JSON.parse(l)).filter(e => e.kind === "delegation.failed")
    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0].details.callID).toBe(callFirst)
    expect(failedEvents[0].details.childSessionID).toBe(childFirst)
  })

  it("correlates child sessions created in reverse task-call order", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const parentID = "ses_reverse_order"
    const callA = "call-a"
    const callB = "call-b"
    const childA = "ses_rev_a"
    const childB = "ses_rev_b"

    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: parentID, agent: "heidi" } } },
    })
    await pluginInstance["chat.message"](
      { sessionID: parentID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    // Task A (backend-coder) then Task B (tester) registered
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callA, args: {} },
      { args: { subagent_type: "backend-coder", prompt: "A" } },
    )
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callB, args: {} },
      { args: { subagent_type: "tester", prompt: "B" } },
    )

    // Child B (tester) created before Child A (backend-coder)
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: { info: { id: childB, parentID, agent: "tester" } },
      },
    })
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: { info: { id: childA, parentID, agent: "backend-coder" } },
      },
    })

    const { childSessionToTask } = await import("../src/index")
    const corrA = childSessionToTask.get(childA)
    const corrB = childSessionToTask.get(childB)
    expect(corrA).toBeDefined()
    expect(corrB).toBeDefined()
    // Child B (tester) gets the tester task (callB), even though it appeared first
    expect(corrB!.callID).toBe(callB)
    expect(corrB!.targetAgent).toBe("tester")
    // Child A (backend-coder) gets the backend-coder task (callA)
    expect(corrA!.callID).toBe(callA)
    expect(corrA!.targetAgent).toBe("backend-coder")
  })

  it("first child fails while second remains active — no cross-talk", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const parentID = "ses_first_fail"
    const callA = "call-fail-a"
    const callB = "call-ok-b"
    const childA = "ses_fail_child_a"
    const childB = "ses_ok_child_b"

    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: parentID, agent: "heidi" } } },
    })
    await pluginInstance["chat.message"](
      { sessionID: parentID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callA, args: {} },
      { args: { subagent_type: "backend-coder", prompt: "A" } },
    )
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callB, args: {} },
      { args: { subagent_type: "tester", prompt: "B" } },
    )

    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: childA, parentID, agent: "backend-coder" } } },
    })
    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: childB, parentID, agent: "tester" } } },
    })

    // Child A fails
    await pluginInstance["event"]({
      event: {
        type: "session.error",
        properties: { info: { id: childA, parentID }, error: "Child A crashed" },
      },
    })

    // Audit: only callA should have delegation.failed
    let auditLines = readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n")
    let failedEvents = auditLines.map(l => JSON.parse(l)).filter(e => e.kind === "delegation.failed")
    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0].details.callID).toBe(callA)

    // Child B completes successfully
    await pluginInstance["tool.execute.after"](
      { tool: "task", sessionID: parentID, callID: callB, args: { subagent_type: "tester" } },
      { output: "Done", metadata: {} },
    )

    auditLines = readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n")
    const completedEvents = auditLines.map(l => JSON.parse(l)).filter(e => e.kind === "delegation.completed")
    expect(completedEvents).toHaveLength(1)
    expect(completedEvents[0].details.callID).toBe(callB)
  })

  it("second child fails while first completes — independent tracking", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const parentID = "ses_second_fail"
    const callOk = "call-ok"
    const callFail = "call-fail"
    const childOk = "ses_child_ok"
    const childFail = "ses_child_fail"

    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: parentID, agent: "heidi" } } },
    })
    await pluginInstance["chat.message"](
      { sessionID: parentID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    // Two calls to different agents
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callOk, args: {} },
      { args: { subagent_type: "backend-coder", prompt: "OK" } },
    )
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callFail, args: {} },
      { args: { subagent_type: "tester", prompt: "FAIL" } },
    )

    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: childOk, parentID, agent: "backend-coder" } } },
    })
    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: childFail, parentID, agent: "tester" } } },
    })

    // First completes OK
    await pluginInstance["tool.execute.after"](
      { tool: "task", sessionID: parentID, callID: callOk, args: { subagent_type: "backend-coder" } },
      { output: "OK", metadata: {} },
    )

    // Second fails
    await pluginInstance["event"]({
      event: {
        type: "session.error",
        properties: { info: { id: childFail, parentID }, error: "Second failed" },
      },
    })

    const auditLines = readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n")
    const auditEvents = auditLines.map(l => JSON.parse(l))
    const completedEvents = auditEvents.filter(e => e.kind === "delegation.completed")
    const failedEvents = auditEvents.filter(e => e.kind === "delegation.failed")

    expect(completedEvents).toHaveLength(1)
    expect(completedEvents[0].details.callID).toBe(callOk)
    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0].details.callID).toBe(callFail)
    expect(failedEvents[0].details.childSessionID).toBe(childFail)
  })

  it("three concurrent calls with two sharing the same target agent", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const parentID = "ses_three_concurrent"
    const callBc1 = "call-bc1"
    const callTester = "call-tester"
    const callBc2 = "call-bc2"

    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: parentID, agent: "heidi" } } },
    })
    await pluginInstance["chat.message"](
      { sessionID: parentID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    // Three registrations: backend-coder, tester, backend-coder
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callBc1, args: {} },
      { args: { subagent_type: "backend-coder", prompt: "BC1" } },
    )
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callTester, args: {} },
      { args: { subagent_type: "tester", prompt: "TEST" } },
    )
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: callBc2, args: {} },
      { args: { subagent_type: "backend-coder", prompt: "BC2" } },
    )

    // All three children created
    const childBc1 = "ses_bc1"
    const childTester = "ses_tester"
    const childBc2 = "ses_bc2"

    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: childBc1, parentID, agent: "backend-coder" } } },
    })
    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: childTester, parentID, agent: "tester" } } },
    })
    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: childBc2, parentID, agent: "backend-coder" } } },
    })

    const { childSessionToTask } = await import("../src/index")
    expect(childSessionToTask.get(childBc1)!.callID).toBe(callBc1)
    expect(childSessionToTask.get(childTester)!.callID).toBe(callTester)
    expect(childSessionToTask.get(childBc2)!.callID).toBe(callBc2)
    expect(childSessionToTask.get(childBc1)!.targetAgent).toBe("backend-coder")
    expect(childSessionToTask.get(childTester)!.targetAgent).toBe("tester")
    expect(childSessionToTask.get(childBc2)!.targetAgent).toBe("backend-coder")

    // Tester fails — only tester task is affected
    await pluginInstance["event"]({
      event: {
        type: "session.error",
        properties: { info: { id: childTester, parentID }, error: "Tester failed" },
      },
    })

    const auditLines = readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n")
    const failedEvents = auditLines.map(l => JSON.parse(l)).filter(e => e.kind === "delegation.failed")
    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0].details.callID).toBe(callTester)
    expect(failedEvents[0].details.childSessionID).toBe(childTester)

    // Both backend-coder tasks complete unaffected
    await pluginInstance["tool.execute.after"](
      { tool: "task", sessionID: parentID, callID: callBc1, args: { subagent_type: "backend-coder" } },
      { output: "BC1 done", metadata: {} },
    )
    await pluginInstance["tool.execute.after"](
      { tool: "task", sessionID: parentID, callID: callBc2, args: { subagent_type: "backend-coder" } },
      { output: "BC2 done", metadata: {} },
    )

    const finalLines = readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n")
    const completedEvents = finalLines.map(l => JSON.parse(l)).filter(e => e.kind === "delegation.completed")
    expect(completedEvents).toHaveLength(2)
    expect(completedEvents.map((e: any) => e.details.callID).sort()).toEqual([callBc1, callBc2])
  })

  it("missing child agent metadata produces diagnostic without deleting active tasks", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const parentID = "ses_no_agent_meta"

    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: parentID, agent: "heidi" } } },
    })
    await pluginInstance["chat.message"](
      { sessionID: parentID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    // Register two calls to different agents
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: "call-x", args: {} },
      { args: { subagent_type: "backend-coder", prompt: "X" } },
    )
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: "call-y", args: {} },
      { args: { subagent_type: "tester", prompt: "Y" } },
    )

    // Child session created WITHOUT agent metadata
    const childNoAgent = "ses_no_agent"
    await pluginInstance["event"]({
      event: {
        type: "session.created",
        properties: { info: { id: childNoAgent, parentID } },  // no agent field
      },
    })

    // With multiple pending calls and no agent info, the dequeue should
    // detect ambiguity and emit a diagnostic instead of attaching to
    // an arbitrary task.
    const auditLines = readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n")
    const blockedEvents = auditLines.map(l => JSON.parse(l)).filter(e => e.kind === "delegation.blocked")
    const unresolvedBlock = blockedEvents.find(e => e.reason?.startsWith("UNRESOLVED_CHILD_CORRELATION:"))
    expect(unresolvedBlock).toBeDefined()

    // All active task calls must remain untouched
    const { sessionTaskCalls } = await import("../src/index")
    const parentCalls = Array.from((sessionTaskCalls as Map<string, any>).entries())
      .filter(([k]) => k.startsWith(`${parentID}:`))
    expect(parentCalls).toHaveLength(2)
  })

  it("duplicate or late session.created does not double-correlate", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const parentID = "ses_dup_event"
    const callID = "call-dup"

    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: parentID, agent: "heidi" } } },
    })
    await pluginInstance["chat.message"](
      { sessionID: parentID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID, args: {} },
      { args: { subagent_type: "backend-coder", prompt: "Dup" } },
    )

    const childDup = "ses_dup_child"
    // Fire session.created twice for the same child
    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: childDup, parentID, agent: "backend-coder" } } },
    })
    // Late duplicate
    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: childDup, parentID, agent: "backend-coder" } } },
    })

    const { childSessionToTask } = await import("../src/index")
    // The second event should NOT create a second correlation entry
    // (Map key is unique, so it overwrites — verify values)
    expect(childSessionToTask.has(childDup)).toBe(true)
    expect(childSessionToTask.get(childDup)!.callID).toBe(callID)
  })

  it("session.error before correlation emits diagnostic without affecting other tasks", async () => {
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const parentID = "ses_error_before_corr"

    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: parentID, agent: "heidi" } } },
    })
    await pluginInstance["chat.message"](
      { sessionID: parentID, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )

    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentID, callID: "call-main", args: {} },
      { args: { subagent_type: "backend-coder", prompt: "Main" } },
    )

    // Child session errors without having been created first
    const childErr = "ses_err_child"
    await pluginInstance["event"]({
      event: {
        type: "session.error",
        properties: { info: { id: childErr, parentID, agent: "backend-coder" }, error: "Early crash" },
      },
    })

    // The session.error handler correlates through the pending-slot FIFO queue
    // (even without session.created), matching the error to the pending task call
    const auditLines = readFileSync(auditLogPath(tmpDir), "utf-8").trim().split("\n")
    const failedEvents = auditLines.map(l => JSON.parse(l)).filter(e => e.kind === "delegation.failed")
    // Should be correlated as a delegation.failed with the actual error message
    const correlatedFail = failedEvents.find(e => e.reason === "Early crash")
    expect(correlatedFail).toBeDefined()
    expect(correlatedFail!.details?.targetAgent).toBe("backend-coder")
    expect(correlatedFail!.details?.childSessionID).toBe(childErr)

    // The correlated task call (call-main) should be removed after resolution
    const { sessionTaskCalls } = await import("../src/index")
    const mainTask = Array.from((sessionTaskCalls as Map<string, any>).entries())
      .find(([k]) => k === `${parentID}:call-main`)
    expect(mainTask).toBeUndefined()
  })

  it("parent cleanup removes every child correlation and active task", () => {
    const parentID = "ses_cleanup_all"
    const child1 = "ses_clean_child1"
    const child2 = "ses_clean_child2"

    // Simulate registered session state
    const { cleanupSessionState, sessionTaskCalls, childSessionToTask } = require("../src/index")
    // Use module internals to set up state
    ;(sessionTaskCalls as Map<string, any>).set(`${parentID}:call1`, { targetAgent: "bc", callerAgent: "heidi", startedAt: 100, resolvedFrom: "subagent_type" })
    ;(sessionTaskCalls as Map<string, any>).set(`${parentID}:call2`, { targetAgent: "tester", callerAgent: "heidi", startedAt: 200, resolvedFrom: "subagent_type" })
    ;(childSessionToTask as Map<string, any>).set(child1, { parentSessionID: parentID, callID: "call1", taskKey: `${parentID}:call1`, targetAgent: "bc" })
    ;(childSessionToTask as Map<string, any>).set(child2, { parentSessionID: parentID, callID: "call2", taskKey: `${parentID}:call2`, targetAgent: "tester" })

    cleanupSessionState(parentID)

    // All task calls for this parent must be deleted
    const remainingTaskCalls = Array.from((sessionTaskCalls as Map<string, any>).keys())
      .filter(k => k.startsWith(`${parentID}:`))
    expect(remainingTaskCalls).toHaveLength(0)

    // All child correlations owned by this parent must be deleted
    const remainingCorrelations = Array.from((childSessionToTask as Map<string, any>).entries())
      .filter(([, c]) => c.parentSessionID === parentID)
    expect(remainingCorrelations).toHaveLength(0)
  })

  it("late child error after cleanup does not affect a new session reusing similar IDs", async () => {
    // Simulate: session A completes cleanup, then a late error from session A's
    // child fires. If IDs overlap with a new session B, session B must not be affected.
    const pluginInstance = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
    const { cleanupSessionState, sessionTaskCalls, childSessionToTask } = await import("../src/index")
    const parentOld = "ses_late_old"
    const childOld = "ses_late_child"
    const parentNew = "ses_late_new"

    // Set up and clean up old session
    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: parentOld, agent: "heidi" } } },
    })
    await pluginInstance["chat.message"](
      { sessionID: parentOld, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentOld, callID: "call-old", args: {} },
      { args: { subagent_type: "backend-coder", prompt: "Old" } },
    )
    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: childOld, parentID: parentOld, agent: "backend-coder" } } },
    })
    cleanupSessionState(parentOld)

    // Set up new session with a child that happens to have the same ID
    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: parentNew, agent: "heidi" } } },
    })
    await pluginInstance["chat.message"](
      { sessionID: parentNew, agent: "heidi" },
      { message: { agent: "heidi", system: "" } as any },
    )
    await pluginInstance["tool.execute.before"](
      { tool: "task", sessionID: parentNew, callID: "call-new", args: {} },
      { args: { subagent_type: "tester", prompt: "New" } },
    )
    await pluginInstance["event"]({
      event: { type: "session.created", properties: { info: { id: `${childOld}_new`, parentID: parentNew, agent: "tester" } } },
    })

    // Late error from old child fires — must not affect new session
    await pluginInstance["event"]({
      event: {
        type: "session.error",
        properties: { info: { id: childOld, parentID: parentOld }, error: "Late crash" },
      },
    })

    // New session's task call must still be active
    const newTaskCalls = Array.from((sessionTaskCalls as Map<string, any>).entries())
      .filter(([k]) => k.startsWith(`${parentNew}:`))
    expect(newTaskCalls).toHaveLength(1)
    expect(newTaskCalls[0][1].targetAgent).toBe("tester")
  })
})
