import { describe, it, expect } from "bun:test"
import { TokenBudgetRuntime } from "../../src/services/token-budget-runtime"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

function ctx(sessionID: string, agent = "heidi", parentID?: string, depth = 0) {
  return { sessionID, agent, parentID, depth }
}

describe("token-budget integration", () => {
  it("full lifecycle: dispatch, reconcile, hard-stop, and block after terminal", async () => {
    const terminals: string[] = []
    const rt = new TokenBudgetRuntime({
      overrides: { enabled: true, profile: "small", runTotal: 10_000, childTotal: 10_000 },
      onTerminal: (_, r) => terminals.push(r),
    })

    // Dispatch within budget.
    const pre = await rt.beforeDispatch(ctx("s-main"), { content: "hello" }, { maxOutputTokens: 1_000 })
    expect(pre.allowed).toBe(true)

    // Reconcile actual usage.
    await rt.reconcileUsage(ctx("s-main"), {
      id: "msg-1",
      tokens: { input: 500, output: 100, cache: { read: 0, write: 0 } },
    })
    expect(rt.getSnapshot("s-main")?.run.consumed).toBe(600)

    // Exhaust the budget: remaining run is 9400, so reserve 8000 (fits),
    // then reconcile 9400 to cross the 10_000 hard stop.
    const big = await rt.beforeDispatch(ctx("s-main"), { content: "x" }, { maxOutputTokens: 8_000 })
    expect(big.allowed).toBe(true)
    await rt.reconcileUsage(ctx("s-main"), {
      id: "msg-2",
      tokens: { input: 9_400, output: 0, cache: { read: 0, write: 0 } },
    })
    expect(rt.getSnapshot("s-main")?.run.terminal?.reason).toBe("budget_exhausted")
    expect(terminals).toContain("budget_exhausted")

    // Further dispatch blocked.
    const blocked = await rt.beforeDispatch(ctx("s-main"), { content: "y" }, { maxOutputTokens: 100 })
    expect(blocked.allowed).toBe(false)
  })

  it("parent and child share the run budget but enforce child ceiling", async () => {
    const rt = new TokenBudgetRuntime({
      overrides: { enabled: true, profile: "small", runTotal: 20_000, childTotal: 5_000 },
    })

    const parent = await rt.beforeDispatch(ctx("s-parent"), { content: "a".repeat(1000) }, { maxOutputTokens: 1_000 })
    expect(parent.allowed).toBe(true)

    // Child within its own ceiling.
    const child1 = await rt.beforeDispatch(ctx("s-child", "child", "s-parent", 1), { content: "b".repeat(1000) }, { maxOutputTokens: 1_000 })
    expect(child1.allowed).toBe(true)
    expect(child1.runId).toBe(parent.runId)

    // Child exceeds its own ceiling → blocked, even though run has room.
    const child2 = await rt.beforeDispatch(ctx("s-child", "child", "s-parent", 1), { content: "c".repeat(3000) }, { maxOutputTokens: 3_000 })
    expect(child2.allowed).toBe(false)
    expect(child2.reason).toBe("CHILD_BUDGET_EXHAUSTED")
  })

  it("durable recovery across restart preserves consumed totals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fd-budget-int-"))
    try {
      const opts = {
        overrides: { enabled: true, profile: "small" as const, runTotal: 50_000, childTotal: 50_000 },
        persistDir: dir,
      }
      const rt1 = new TokenBudgetRuntime(opts)
      await rt1.beforeDispatch(ctx("s-main"), { content: "x".repeat(1000) }, { maxOutputTokens: 1_000 })
      await rt1.reconcileUsage(ctx("s-main"), {
        id: "msg-1",
        tokens: { input: 2_000, output: 500, cache: { read: 0, write: 0 } },
      })
      expect(rt1.getSnapshot("s-main")?.run.consumed).toBe(2_500)

      // Restart: fresh runtime over same dir recovers consumed state.
      const rt2 = new TokenBudgetRuntime(opts)
      rt2.registerSession(ctx("s-main"))
      expect(rt2.getSnapshot("s-main")?.run.consumed).toBe(2_500)

      // And continues enforcing against the recovered budget.
      const pre = await rt2.beforeDispatch(ctx("s-main"), { content: "y".repeat(1000) }, { maxOutputTokens: 1_000 })
      expect(pre.allowed).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("session end releases pending reservations", async () => {
    const rt = new TokenBudgetRuntime({
      overrides: { enabled: true, profile: "small", runTotal: 10_000, childTotal: 10_000 },
    })
    await rt.beforeDispatch(ctx("s-main"), { content: "x".repeat(1000) }, { maxOutputTokens: 1_000 })
    const reservedBefore = rt.getSnapshot("s-main")?.run.reserved ?? 0
    expect(reservedBefore).toBeGreaterThan(0)
    await rt.onSessionEnd(ctx("s-main"), "aborted")
    expect(rt.getSnapshot("s-main")?.run.reserved).toBe(0)
  })
})