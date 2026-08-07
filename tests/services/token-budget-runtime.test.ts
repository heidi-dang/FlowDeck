import { describe, it, expect } from "bun:test"
import { TokenBudgetRuntime } from "../../src/services/token-budget-runtime"

function ctx(sessionID: string, agent = "heidi", parentID?: string, depth = 0) {
  return { sessionID, agent, parentID, depth }
}

describe("TokenBudgetRuntime", () => {
  it("allows dispatch within budget and reconciles usage", async () => {
    const warnings: string[] = []
    const terminals: string[] = []
    const rt = new TokenBudgetRuntime({
      overrides: { enabled: true, profile: "small", runTotal: 10_000, childTotal: 10_000 },
      onWarning: (_, m) => warnings.push(m),
      onTerminal: (_, r) => terminals.push(r),
    })

    const pre = await rt.beforeDispatch(ctx("s-main"), { role: "user", content: "hello" }, { maxOutputTokens: 500 })
    expect(pre.allowed).toBe(true)

    await rt.reconcileUsage(ctx("s-main"), {
      id: "msg-1",
      tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } },
      cost: 0.001,
      modelID: "m",
      providerID: "p",
    })
    const snap = rt.getSnapshot("s-main")
    expect(snap?.run.consumed).toBe(150)
    expect(snap?.run.reserved).toBe(0)
  })

  it("blocks dispatch when budget exhausted", async () => {
    const rt = new TokenBudgetRuntime({
      overrides: { enabled: true, profile: "small", runTotal: 1_000, childTotal: 1_000 },
    })
    const r1 = await rt.beforeDispatch(ctx("s-main"), { content: "x".repeat(2000) }, { maxOutputTokens: 100 })
    expect(r1.allowed).toBe(true)
    const r2 = await rt.beforeDispatch(ctx("s-main"), { content: "y".repeat(2000) }, { maxOutputTokens: 100 })
    expect(r2.allowed).toBe(false)
  })

  it("shares run budget across parent and child sessions", async () => {
    const rt = new TokenBudgetRuntime({
      overrides: { enabled: true, profile: "small", runTotal: 5_000, childTotal: 5_000 },
    })
    const parent = await rt.beforeDispatch(ctx("s-parent"), { content: "a".repeat(1000) }, { maxOutputTokens: 1_000 })
    expect(parent.allowed).toBe(true)
    const child = await rt.beforeDispatch(ctx("s-child", "child", "s-parent", 1), { content: "b".repeat(1000) }, { maxOutputTokens: 1_000 })
    expect(child.allowed).toBe(true)
    // Same run id for both.
    expect(parent.runId).toBe(child.runId)
  })

  it("releases pending reservations on session end", async () => {
    const rt = new TokenBudgetRuntime({
      overrides: { enabled: true, profile: "small", runTotal: 10_000, childTotal: 10_000 },
    })
    await rt.beforeDispatch(ctx("s-main"), { content: "x".repeat(1000) }, { maxOutputTokens: 1_000 })
    const before = rt.getSnapshot("s-main")?.run.reserved ?? 0
    expect(before).toBeGreaterThan(0)
    await rt.onSessionEnd(ctx("s-main"), "aborted")
    const after = rt.getSnapshot("s-main")?.run.reserved ?? 0
    expect(after).toBe(0)
  })

  it("records usage even when no pending reservation exists", async () => {
    const rt = new TokenBudgetRuntime({
      overrides: { enabled: true, profile: "small", runTotal: 10_000, childTotal: 10_000 },
    })
    await rt.reconcileUsage(ctx("s-main"), {
      id: "msg-orphan",
      tokens: { input: 50, output: 10, cache: { read: 0, write: 0 } },
    })
    expect(rt.getSnapshot("s-main")?.run.consumed).toBe(60)
  })
})