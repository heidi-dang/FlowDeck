import { describe, it, expect } from "bun:test"
import flowDeckPlugin from "../src/index"
import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { semanticConvergenceGuard } from "../src/services/semantic-convergence-guard"

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), "fd-r2idx-"))
  writeFileSync(join(dir, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict" } }))
  return dir
}
function clean(d: string) { try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch {} }
async function make(dir: string) {
  const instance = (await flowDeckPlugin.server({ directory: dir, client: { app: { log: async () => {} } } } as any)) as any
  return instance
}

describe("ROUND-2 index integration (real plugin surface)", () => {
  it("fdx-read with a file arg does NOT count as source mutation / does NOT reset convergence", async () => {
    const dir = makeDir()
    writeFileSync(join(dir, "a.ts"), "export const A = 1" + "\n", "utf8")
    writeFileSync(join(dir, "b.ts"), "export const B = 2" + "\n", "utf8")
    writeFileSync(join(dir, "c.ts"), "export const C = 3" + "\n", "utf8")
    const target = ["a.ts", "b.ts", "c.ts"]
    const instance = await make(dir)
    await instance["event"]({ event: { type: "session.created", properties: { info: { id: "s1", agent: "heidi" } } } })
    await instance["chat.message"]({ sessionID: "s1", agent: "heidi" }, { message: { agent: "heidi", system: "" } as any })
    for (let i = 0; i < 3; i++) {
      const file = target[i]
      await instance["tool.execute.before"]({ tool: "fdx-read", sessionID: "s1", callID: "read-" + i, args: { file } }, { args: { file } } as any)
      await instance["tool.execute.after"](
        { tool: "fdx-read", sessionID: "s1", callID: "read-" + i, args: { file } },
        { output: "export const " + file[0].toUpperCase() + " = 1", metadata: {} },
      )
    }
    const state = semanticConvergenceGuard.getState("s1")!
    expect(state.meaningfulProgressEpoch).toBe(1)
    expect(state.toolCallsSinceProgress).toBeGreaterThanOrEqual(3)
    clean(dir)
  })

  it("a real write/edit IS a confirmed mutation and resets convergence", async () => {
    const dir = makeDir()
    writeFileSync(join(dir, "a.ts"), "export const A = 1" + "\n", "utf8")
    const instance = await make(dir)
    await instance["event"]({ event: { type: "session.created", properties: { info: { id: "s2", agent: "heidi" } } } })
    await instance["chat.message"]({ sessionID: "s2", agent: "heidi" }, { message: { agent: "heidi", system: "" } as any })
    await instance["tool.execute.before"]({ tool: "fdx-read", sessionID: "s2", callID: "r", args: { file: "a.ts" } }, { args: { file: "a.ts" } } as any)
    await instance["tool.execute.after"]({ tool: "fdx-read", sessionID: "s2", callID: "r", args: { file: "a.ts" } }, { output: "x", metadata: {} } as any)
    const before = semanticConvergenceGuard.getState("s2")!
    await instance["tool.execute.before"]({ tool: "write", sessionID: "s2", callID: "w", args: { file: "a.ts" } }, { args: { file: "a.ts" } } as any)
    await instance["tool.execute.after"]({ tool: "write", sessionID: "s2", callID: "w", args: { file: "a.ts" } }, { output: "ok", metadata: {} } as any)
    const after = semanticConvergenceGuard.getState("s2")!
    expect(after.meaningfulProgressEpoch).toBe(before.meaningfulProgressEpoch + 1)
    expect(after.toolCallsSinceProgress).toBe(0)
    clean(dir)
  })

  it("tool.execute.after renders visible FlowDeck NN% title + fd.selfAudit metadata, never in output text", async () => {
    const dir = makeDir()
    const instance = await make(dir)
    await instance["event"]({ event: { type: "session.created", properties: { info: { id: "s3", agent: "heidi" } } } })
    await instance["chat.message"]({ sessionID: "s3", agent: "heidi" }, { message: { agent: "heidi", system: "" } as any })
    const afterOut: any = { output: "npm test" + "\n", metadata: {} }
    await instance["tool.execute.after"]({ tool: "bash", sessionID: "s3", callID: "c1", args: { command: "npm test" } }, afterOut)
    expect(String(afterOut.title || "")).toMatch(/FlowDeck \d+%/)
    expect(afterOut.metadata?.fd?.selfAudit?.score).toBeGreaterThanOrEqual(0)
    expect(afterOut.metadata?.fd?.selfAudit?.score).toBeLessThanOrEqual(100)
    expect(afterOut.output).toBe("npm test" + "\n")
    clean(dir)
  })

  it("audit latency breakdown for a tool is REAL (all >= 0, no synthetic 0.05/0.03 constants)", async () => {
    const dir = makeDir()
    const instance = await make(dir)
    await instance["event"]({ event: { type: "session.created", properties: { info: { id: "s4", agent: "heidi" } } } })
    await instance["chat.message"]({ sessionID: "s4", agent: "heidi" }, { message: { agent: "heidi", system: "" } as any })
    const out: any = { output: "ok", metadata: {} }
    await instance["tool.execute.before"]({ tool: "fdx-read", sessionID: "s4", callID: "x", args: { file: "a.ts" } }, { args: { file: "a.ts" } } as any)
    await instance["tool.execute.after"]({ tool: "fdx-read", sessionID: "s4", callID: "x", args: { file: "a.ts" } }, out)
    const { runtimeSelfAudit } = await import("../src/services/runtime-self-audit")
    const events = runtimeSelfAudit.recentEvents("s4")
    const toolEv = events.find(e => e.operation === "fdx-read")
    expect(toolEv).toBeDefined()
    const phases = toolEv!.latencyBreakdown
    expect(phases.length).toBeGreaterThanOrEqual(3)
    for (const p of phases) {
      expect(p.ms).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(p.ms)).toBe(true)
    }
    // All phases come from real measured checkpoints (tool-before-total,
    // loop-guard, before-complete, tool-runtime, convergence, self-audit). The
    // old synthetic-only phase names/placeholders must never appear.
    const realPhaseNames = new Set(["tool-before-total", "loop-guard", "before-complete", "tool-runtime", "convergence", "self-audit"])
    const names = phases.map(p => p.name)
    expect(names.some(n => realPhaseNames.has(n))).toBe(true)
    expect(names.includes("pre_hook")).toBe(false)
    expect(names.includes("post_processing")).toBe(false)
    // A measured total must be represented (tool-runtime exists and is >= 0).
    const runtimePhase = phases.find(p => p.name === "tool-runtime")
    expect(runtimePhase).toBeDefined()
    clean(dir)
  })
})
