import { describe, it, expect, beforeEach } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  handleUserMessage,
  handleInternalContinuation,
  renderTurnContext,
  completeTask,
  prefetchRepositoryBatch,
  liveCorePromptTokens,
  _resetFastHarnessRuntime,
} from "../src/services/heidi-fast-harness-runtime"
import { getRouteDecision, listRouteDecisions, _resetRouteState } from "../src/services/heidi-route-state"
import { getTaskState, _resetAllTaskState } from "../src/services/heidi-task-state"
import { _resetAllTrackers } from "../src/services/heidi-performance"

describe("HeidiFastHarnessRuntime — live facade", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fh-runtime-"))
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test", scripts: { test: "bun test", build: "bun build", typecheck: "tsc" } }))
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }))
    _resetFastHarnessRuntime()
    _resetAllTaskState()
    _resetAllTrackers()
    _resetRouteState()
  })

  it("manual user task: classifies once and records route decision + task state", async () => {
    const turn = await handleUserMessage("sess-1", "Security audit of the auth module", dir)
    expect(turn.isNewTask).toBe(true)
    expect(turn.decision?.executionClass).toBe("SPECIALIST")
    expect(turn.decision?.specialists).toContain("SECURITY")
    expect(turn.decision?.suggestedAgents).toContain("security-auditor")
    const route = getRouteDecision("sess-1")
    expect(route).not.toBeNull()
    expect(route!.taskId).toBe(turn.taskId)
    const st = getTaskState(turn.taskId)
    expect(st).toBeDefined()
    const snap = st!.snapshot()
    expect(snap.currentPhase).toBe("routing")
    expect(snap.executionClass).toBe("SPECIALIST")
  })

  it("FAST_DIRECT manual task: no delegation sections in turn context", async () => {
    await handleUserMessage("sess-2", "fix a typo in the readme", dir)
    const ctx = renderTurnContext("sess-2", dir)
    expect(ctx).not.toContain("Delegation Contract")
    expect(ctx).not.toContain("Available Agents")
    expect(ctx).not.toContain("Stage")
    expect(ctx).not.toContain("Approval Gates")
    expect(ctx).toContain("[TaskState]")
  })

  it("internal continuation does NOT reclassify and does NOT reset route", async () => {
    await handleUserMessage("sess-3", "Debug why the login test fails", dir)
    const before = getRouteDecision("sess-3")!.taskId
    handleInternalContinuation("sess-3")
    handleInternalContinuation("sess-3")
    const after = getRouteDecision("sess-3")!.taskId
    expect(after).toBe(before)
    const route = getRouteDecision("sess-3")!
    expect(route.continuationCount).toBe(2)
    const st = getTaskState(before)
    expect(st!.snapshot().executionClass).toBe("SPECIALIST")
  })

  it("resume preserves the existing route + task state (no fresh reclassification)", async () => {
    const t1 = await handleUserMessage("sess-4", "Build the frontend form and backend API", dir)
    const taskId = t1.taskId
    expect(t1.decision!.executionClass).toBe("PARALLEL_SPECIALISTS")
    const t2 = await handleUserMessage("sess-4", "also add validation to the form please", dir)
    expect(t2.resumed).toBe(true)
    expect(t2.taskId).toBe(taskId)
    expect(t2.decision!.executionClass).toBe("PARALLEL_SPECIALISTS")
  })

  it("task state packet stays under 200 tokens for a normal task", async () => {
    await handleUserMessage("sess-5", "Refactor the auth service across several files", dir)
    const st = getTaskState(getRouteDecision("sess-5")!.taskId)!
    const packet = st.renderContextPacket()
    // ~4 chars/token; assert < 800 chars so the packet is < 200 tokens.
    expect(packet.length).toBeLessThan(800)
    expect(packet).not.toContain("chain")
  })

  it("backend workstream routes to backend-coder (never reviewer)", async () => {
    const turn = await handleUserMessage("sess-6", "Implement the REST API endpoint for users", dir)
    expect(turn.decision!.executionClass).toBe("SPECIALIST")
    if (turn.decision!.executionClass === "SPECIALIST") {
      expect(turn.decision!.specialists).toContain("BACKEND")
      expect(turn.decision!.suggestedAgents).toContain("backend-coder")
      expect(turn.decision!.suggestedAgents).not.toContain("reviewer")
    }
  })

  it("prefetchRepositoryBatch returns a compact structured packet with concurrent reads", async () => {
    const packet = await prefetchRepositoryBatch(dir)
    expect(packet).toContain("[ReadBatch]")
    expect(packet).toContain("package.json:bytes=")
  })

  it("completeTask clears route state and returns a safe summary", async () => {
    await handleUserMessage("sess-7", "fix a typo", dir)
    const summary = completeTask("sess-7")
    expect(summary).not.toBeNull()
    if (summary) {
      expect(summary).toContain("class:FAST_DIRECT")
      expect(summary).not.toContain("secret")
    }
    expect(getRouteDecision("sess-7")).toBeNull()
    expect(listRouteDecisions().length).toBe(0)
  })

  it("live core prompt token estimate stays under 900 tokens", () => {
    const tokens = liveCorePromptTokens()
    expect(tokens).toBeLessThan(900)
    expect(tokens).toBeGreaterThan(200)
  })

  it("resume of COMPLETED task starts a fresh classification", async () => {
    const t1 = await handleUserMessage("sess-8", "fix typo in readme", dir)
    completeTask("sess-8")
    const t2 = await handleUserMessage("sess-8", "now add a fetch client file", dir)
    expect(t2.isNewTask).toBe(true)
    expect(t2.taskId).not.toBe(t1.taskId)
  })

  it("parallel frontend+backend resolves to both specialists", async () => {
    const turn = await handleUserMessage("sess-9", "Build the frontend form and backend API", dir)
    expect(turn.decision!.executionClass).toBe("PARALLEL_SPECIALISTS")
    const agents = turn.decision!.suggestedAgents ?? []
    expect(agents).toContain("frontend-coder")
    expect(agents).toContain("backend-coder")
  })

  it("deep task renders full workflow gates in turn context", async () => {
    await handleUserMessage("sess-10", "architecture migration from Express to Fastify", dir)
    const ctx = renderTurnContext("sess-10", dir)
    expect(ctx).toContain("Approval Gates")
    expect(ctx).toContain("Stage")
  })
})
