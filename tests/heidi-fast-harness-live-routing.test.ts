import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import flowDeckPlugin, { cleanupSessionState } from "../src/index"
import { getRouteDecision, listRouteDecisions, _resetRouteState } from "../src/services/heidi-route-state"
import { getTaskState, _resetAllTaskState } from "../src/services/heidi-task-state"
import { _resetAllTrackers } from "../src/services/heidi-performance"
import { _resetFastHarnessRuntime } from "../src/services/heidi-fast-harness-runtime"
import { resetAuditBufferForTests } from "../src/services/audit-log"

function makeTmp(): string {
  const dir = join(tmpdir(), `fd-test-live-route-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "rt", scripts: {} }))
  writeFileSync(join(dir, ".flowdeck.json"), JSON.stringify({ governance: { mode: "advisory" } }))
  return dir
}

describe("HeidiFastHarness — live routing through chat.message", () => {
  let tmpDir: string
  let plugin: any

  beforeEach(async () => {
    tmpDir = makeTmp()
    _resetRouteState()
    _resetAllTaskState()
    _resetAllTrackers()
    _resetFastHarnessRuntime()
    resetAuditBufferForTests()
    plugin = (await flowDeckPlugin.server({ directory: tmpDir, client: { app: { log: async () => {} } } } as any)) as any
  })

  afterEach(async () => {
    try { await cleanupSessionState(tmpDir as any) } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    _resetRouteState()
    _resetAllTaskState()
    _resetAllTrackers()
  })

  function sendMessage(sessionID: string, content: string, msgId: string) {
    return plugin["chat.message"](
      { sessionID, agent: "heidi" },
      { message: { agent: "heidi", id: msgId, content } as any },
    )
  }

  it("real manual debug task routes to debug-specialist on the first turn", async () => {
    await sendMessage("ses-A", "Debug why this test is failing", "msg-a1")
    const route = getRouteDecision("ses-A")
    expect(route).not.toBeNull()
    expect(route!.decision.executionClass).toBe("SPECIALIST")
    expect(route!.decision.suggestedAgents).toContain("debug-specialist")
    const st = getTaskState(route!.taskId)
    expect(st).toBeDefined()
  })

  it("security audit delegates immediately to security-auditor", async () => {
    await sendMessage("ses-B", "security audit of the authentication flow", "msg-b1")
    const route = getRouteDecision("ses-B")!
    expect(route.decision.suggestedAgents).toContain("security-auditor")
  })

  it("frontend UI task routes to frontend-coder", async () => {
    await sendMessage("ses-C", "build a React component for the user dashboard UI", "msg-c1")
    const route = getRouteDecision("ses-C")!
    expect(route.decision.suggestedAgents).toContain("frontend-coder")
  })

  it("frontend + backend independent task resolves to both specialists", async () => {
    await sendMessage("ses-D", "Build the frontend form and backend API", "msg-d1")
    const route = getRouteDecision("ses-D")!
    expect(route.decision.executionClass).toBe("PARALLEL_SPECIALISTS")
    expect(route.decision.suggestedAgents).toContain("frontend-coder")
    expect(route.decision.suggestedAgents).toContain("backend-coder")
  })

  it("backend-only workstream routes to backend-coder, never reviewer", async () => {
    await sendMessage("ses-E", "Implement the backend API endpoint for creating orders", "msg-e1")
    const route = getRouteDecision("ses-E")!
    expect(route.decision.suggestedAgents).not.toContain("reviewer")
    expect(route.decision.suggestedAgents).toContain("backend-coder")
  })

  it("tiny single-file prompt gets FAST_DIRECT with lean route", async () => {
    await sendMessage("ses-F", "fix a typo in the readme", "msg-f1")
    const route = getRouteDecision("ses-F")!
    expect(route.decision.executionClass).toBe("FAST_DIRECT")
    // No delegation sections injected into the system prompt for FAST_DIRECT:
    const ctx = await import("../src/services/heidi-fast-harness-runtime").then(m => m.renderTurnContext("ses-F", tmpDir))
    expect(ctx).not.toContain("Delegation Contract")
    expect(ctx).not.toContain("Available Agents")
  })

  it("internal continuation prompt does not reclassify nor reset the route", async () => {
    await sendMessage("ses-G", "Debug the failing inventory test", "msg-g1")
    const before = getRouteDecision("ses-G")!.taskId
    // An internal-prompt text that flowdeck itself would generate must not create a new task.
    // Simulate: same route; a follow-up chat.message with the SAME text is a duplicate — preserved.
    await sendMessage("ses-G", "Debug the failing inventory test", "msg-g1-dup")
    const after = getRouteDecision("ses-G")!.taskId
    expect(after).toBe(before)
  })

  it("manual supersede: new explicit task after completion starts fresh", async () => {
    await sendMessage("ses-H", "fix typo in readme", "msg-h1")
    const first = getRouteDecision("ses-H")!.taskId
    const { completeTask } = await import("../src/services/heidi-fast-harness-runtime")
    completeTask("ses-H")
    await sendMessage("ses-H", "now refactor the api service across several files", "msg-h2")
    const second = getRouteDecision("ses-H")!.taskId
    expect(second).not.toBe(first)
    expect(getRouteDecision("ses-H")!.decision.executionClass).toBe("STANDARD")
  })

  it("session registry shows one active routed task per session", async () => {
    await sendMessage("ses-I", "security audit", "msg-i1")
    const routes = listRouteDecisions().filter(r => r.sessionID === "ses-I")
    expect(routes).toHaveLength(1)
    expect(routes[0].executionClass).toBe("SPECIALIST")
  })
})
