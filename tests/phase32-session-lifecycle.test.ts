import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import flowDeckPlugin, {
  cleanupSessionState,
  getSessionMetricsDiagnostics,
} from "@/index"
import { toolGuardHook, getWriteCount, recordWrite } from "@/hooks/tool-guard"
import { LoopDetector } from "@/services/loop-detector"

const TMP = join(tmpdir(), "phase32-session-test-" + Date.now())

function createMockClient(overrides: Record<string, any> = {}) {
  return {
    app: {
      log: overrides.log ?? (async () => {}),
    },
  }
}

describe("Phase 32 — Terminal-Session Lifecycle Cleanup", () => {
  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }) } catch {}
  })

  it("completed session removes all state", async () => {
    const sessionID = `sess-complete-${Date.now()}`
    const client = createMockClient()
    const p: any = await flowDeckPlugin({ directory: TMP, client: client as any } as any, {})

    // Start session and simulate tool execution to accumulate metrics
    await p.event({ event: { type: "session.started", properties: { info: { id: sessionID } } } })
    await toolGuardHook({ directory: TMP }, { tool: "write_file", name: "write_file", sessionID }, { args: { filePath: "src/a.ts" } })

    const beforeDiag = getSessionMetricsDiagnostics(sessionID)
    expect(beforeDiag.startTime).toBeDefined()

    // Complete session
    await p.event({ event: { type: "session.completed", properties: { info: { id: sessionID } } } })

    const afterDiag = getSessionMetricsDiagnostics(sessionID)
    expect(afterDiag.toolCalls).toBe(0)
    expect(afterDiag.startTime).toBeUndefined()
    expect(afterDiag.filesChangedCount).toBe(0)
    expect(getWriteCount(sessionID)).toBe(0)
  })

  it("errored session removes all state", async () => {
    const sessionID = `sess-error-${Date.now()}`
    const client = createMockClient()
    const p: any = await flowDeckPlugin({ directory: TMP, client: client as any } as any, {})

    await p.event({ event: { type: "session.started", properties: { info: { id: sessionID } } } })
    await toolGuardHook({ directory: TMP }, { tool: "write_file", name: "write_file", sessionID }, { args: { filePath: "src/b.ts" } })

    await p.event({ event: { type: "session.error", properties: { info: { id: sessionID } } } })

    const afterDiag = getSessionMetricsDiagnostics(sessionID)
    expect(afterDiag.toolCalls).toBe(0)
    expect(afterDiag.startTime).toBeUndefined()
    expect(getWriteCount(sessionID)).toBe(0)
  })

  it("idle session preserves nonterminal metrics", async () => {
    const sessionID = `sess-idle-${Date.now()}`
    const client = createMockClient()
    const p: any = await flowDeckPlugin({ directory: TMP, client: client as any } as any, {})

    await p.event({ event: { type: "session.started", properties: { info: { id: sessionID } } } })
    recordWrite(sessionID, "src/c.ts")

    const beforeDiag = getSessionMetricsDiagnostics(sessionID)
    expect(beforeDiag.startTime).toBeDefined()

    // Send idle event
    await p.event({ event: { type: "session.idle", properties: { info: { id: sessionID } } } })

    // Idle session MUST preserve nonterminal metrics
    const afterDiag = getSessionMetricsDiagnostics(sessionID)
    expect(afterDiag.startTime).toEqual(beforeDiag.startTime)
    expect(getWriteCount(sessionID)).toBe(1)
  })

  it("cleanup is idempotent", () => {
    const sessionID = `sess-idempotent-${Date.now()}`
    const ld = new LoopDetector()

    // Run cleanup multiple times on same session ID
    expect(() => {
      cleanupSessionState(sessionID, ld)
      cleanupSessionState(sessionID, ld)
      cleanupSessionState(sessionID, ld)
    }).not.toThrow()

    const diag = getSessionMetricsDiagnostics(sessionID)
    expect(diag.toolCalls).toBe(0)
  })

  it("cleanup runs when appLog throws", async () => {
    const sessionID = `sess-log-fail-${Date.now()}`
    const client = createMockClient({
      log: async () => {
        throw new Error("Network logging failed")
      },
    })
    const p: any = await flowDeckPlugin({ directory: TMP, client: client as any } as any, {})

    await p.event({ event: { type: "session.started", properties: { info: { id: sessionID } } } })
    await toolGuardHook({ directory: TMP }, { tool: "write_file", name: "write_file", sessionID }, { args: { filePath: "src/d.ts" } })

    try {
      await p.event({ event: { type: "session.completed", properties: { info: { id: sessionID } } } })
    } catch {
      // ignore
    }

    const afterDiag = getSessionMetricsDiagnostics(sessionID)
    expect(afterDiag.toolCalls).toBe(0)
    expect(afterDiag.startTime).toBeUndefined()
  })

  it("reused session ID starts from zero after terminal cleanup", async () => {
    const sessionID = `sess-reused-${Date.now()}`
    const client = createMockClient()
    const p: any = await flowDeckPlugin({ directory: TMP, client: client as any } as any, {})

    // First session use
    await p.event({ event: { type: "session.started", properties: { info: { id: sessionID } } } })
    await toolGuardHook({ directory: TMP }, { tool: "write_file", name: "write_file", sessionID }, { args: { filePath: "src/e.ts" } })
    await p.event({ event: { type: "session.completed", properties: { info: { id: sessionID } } } })

    // Re-use session ID
    await p.event({ event: { type: "session.started", properties: { info: { id: sessionID } } } })

    const diag = getSessionMetricsDiagnostics(sessionID)
    expect(diag.toolCalls).toBe(0)
    expect(diag.filesChangedCount).toBe(0)
    expect(getWriteCount(sessionID)).toBe(0)
  })

  it("loop detector state and write counters are cleared", () => {
    const sessionID = `sess-ld-wc-${Date.now()}`
    const ld = new LoopDetector()

    // Add action to loop detector
    ld.recordAfter("read", { filePath: "a.ts" }, "file content", sessionID, "success")
    expect(ld.getHistory(sessionID).length).toBeGreaterThan(0)

    cleanupSessionState(sessionID, ld)

    expect(ld.getHistory(sessionID).length).toBe(0)
    expect(getWriteCount(sessionID)).toBe(0)
  })
})
