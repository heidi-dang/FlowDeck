import { describe, it, expect } from "bun:test"
import { normalizeUsage, TokenBudgetController } from "../../src/services/token-budget-controller"
import { resolveTokenBudgetConfig } from "../../src/config/token-budget-config"
import { InMemoryTokenUsageStore } from "../../src/services/token-usage-store"

function makeConfig(overrides: Record<string, unknown> = {}) {
  return resolveTokenBudgetConfig({
    enabled: true,
    profile: "small",
    runTotal: 250_000,
    childTotal: 80_000,
    warningThreshold: 0.8,
    hardStopThreshold: 1.0,
    maxRequestInputTokens: 50_000,
    maxRequestOutputTokens: 10_000,
    ...(overrides as object),
  })
}

function reserveOpts(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    sessionId: "session-main",
    agentId: "heidi",
    requestId: "req-1",
    estimatedInputTokens: 1_000,
    maxOutputTokens: 500,
    ...(overrides as object),
  }
}

describe("normalizeUsage", () => {
  it("sums billable components and keeps cache distinct", () => {
    const u = normalizeUsage({ input: 100, output: 20, reasoning: 5, cacheRead: 300, cacheWrite: 50 })
    expect(u.billable).toBe(475)
    expect(u.cacheRead).toBe(300)
  })

  it("falls back to reserved input when usage missing", () => {
    const u = normalizeUsage({}, 1_000)
    expect(u.input).toBe(1_000)
    expect(u.billable).toBe(1_000)
  })

  it("ignores negative / non-finite values", () => {
    const u = normalizeUsage({ input: -5, output: Number.NaN, cacheRead: "x" as unknown as number })
    expect(u.input).toBe(0)
    expect(u.output).toBe(0)
    expect(u.cacheRead).toBe(0)
  })
})

describe("TokenBudgetController", () => {
  it("reserves budget before dispatch and rejects oversubscription", async () => {
    const cfg = makeConfig({ runTotal: 1_000, childTotal: 1_000 })
    const ctrl = new TokenBudgetController(cfg)
    const r1 = await ctrl.reserveRequest(reserveOpts({ estimatedInputTokens: 600, maxOutputTokens: 300 }))
    expect(r1.allowed).toBe(true)
    expect(r1.claimed).toBe(900)

    const r2 = await ctrl.reserveRequest(reserveOpts({ requestId: "req-2", estimatedInputTokens: 600, maxOutputTokens: 300 }))
    expect(r2.allowed).toBe(false)
    expect(r2.reason).toBe("BUDGET_EXHAUSTED")
    expect(r2.claimed).toBe(0)
  })

  it("enforces child ceiling independently", async () => {
    const cfg = makeConfig({ runTotal: 100_000, childTotal: 2_000 })
    const ctrl = new TokenBudgetController(cfg)
    ctrl.registerSession("session-child", "child", "session-main")

    const ok = await ctrl.reserveRequest(
      reserveOpts({ sessionId: "session-child", agentId: "child", requestId: "req-1", estimatedInputTokens: 1_500, maxOutputTokens: 300 }),
    )
    expect(ok.allowed).toBe(true)

    const rejected = await ctrl.reserveRequest(
      reserveOpts({ sessionId: "session-child", agentId: "child", requestId: "req-2", estimatedInputTokens: 1_500, maxOutputTokens: 300 }),
    )
    expect(rejected.allowed).toBe(false)
    expect(rejected.reason).toBe("CHILD_BUDGET_EXHAUSTED")

    // Parent can still dispatch — child ceiling is per-child.
    const parentOk = await ctrl.reserveRequest(
      reserveOpts({ sessionId: "session-main", requestId: "req-3", estimatedInputTokens: 1_000, maxOutputTokens: 500 }),
    )
    expect(parentOk.allowed).toBe(true)
  })

  it("reconciles usage and releases unused output reservation", async () => {
    const cfg = makeConfig({ runTotal: 100_000 })
    const ctrl = new TokenBudgetController(cfg)
    const r = await ctrl.reserveRequest(reserveOpts({ estimatedInputTokens: 1_000, maxOutputTokens: 500 }))
    expect(r.allowed).toBe(true)

    // Provider reported only 400 input, 50 output → billable 450, reservation was 1500.
    const commit = await ctrl.commitUsage({
      runId: "run-1",
      sessionId: "session-main",
      agentId: "heidi",
      requestId: "req-1",
      reservationId: r.reservationId,
      usage: { input: 400, output: 50 },
    })
    expect(commit.committed).toBe(true)
    expect(commit.releasedUnused).toBe(1_050)
    expect(ctrl.remainingRun()).toBe(100_000 - 450)
  })

  it("is idempotent per requestId/messageId", async () => {
    const cfg = makeConfig({ runTotal: 100_000 })
    const ctrl = new TokenBudgetController(cfg)
    const r = await ctrl.reserveRequest(reserveOpts())
    await ctrl.commitUsage({
      runId: "run-1",
      sessionId: "session-main",
      agentId: "heidi",
      requestId: "req-1",
      messageId: "msg-1",
      reservationId: r.reservationId,
      usage: { input: 100, output: 50 },
    })
    const second = await ctrl.commitUsage({
      runId: "run-1",
      sessionId: "session-main",
      agentId: "heidi",
      requestId: "req-1",
      messageId: "msg-1",
      reservationId: r.reservationId,
      usage: { input: 100_000, output: 100_000 },
    })
    expect(second.committed).toBe(false)
    expect(second.billable).toBe(0)
    expect(ctrl.remainingRun()).toBe(100_000 - 150)
  })

  it("fires warning once at threshold", async () => {
    const cfg = makeConfig({ runTotal: 10_000, childTotal: 10_000, warningThreshold: 0.8, hardStopThreshold: 1.0 })
    const ctrl = new TokenBudgetController(cfg)
    const r = await ctrl.reserveRequest(reserveOpts({ estimatedInputTokens: 0, maxOutputTokens: 8_500 }))
    const c1 = await ctrl.commitUsage({
      runId: "run-1",
      sessionId: "session-main",
      agentId: "heidi",
      requestId: "req-1",
      reservationId: r.reservationId,
      usage: { input: 8_500, output: 0 },
    })
    expect(c1.warningFired).toBe(true)

    // Second commit below terminal does not re-fire warning.
    const r2 = await ctrl.reserveRequest(reserveOpts({ requestId: "req-2", estimatedInputTokens: 0, maxOutputTokens: 500 }))
    const c2 = await ctrl.commitUsage({
      runId: "run-1",
      sessionId: "session-main",
      agentId: "heidi",
      requestId: "req-2",
      reservationId: r2.reservationId,
      usage: { input: 500, output: 0 },
    })
    expect(c2.warningFired).toBe(false)
  })

  it("hard-stops at threshold and blocks further dispatch", async () => {
    const cfg = makeConfig({ runTotal: 10_000, childTotal: 10_000, hardStopThreshold: 1.0 })
    const ctrl = new TokenBudgetController(cfg)
    const r = await ctrl.reserveRequest(reserveOpts({ estimatedInputTokens: 0, maxOutputTokens: 10_000 }))
    const c = await ctrl.commitUsage({
      runId: "run-1",
      sessionId: "session-main",
      agentId: "heidi",
      requestId: "req-1",
      reservationId: r.reservationId,
      usage: { input: 10_000, output: 0 },
    })
    expect(c.terminal?.reason).toBe("budget_exhausted")

    const blocked = await ctrl.reserveRequest(reserveOpts({ requestId: "req-2", estimatedInputTokens: 100 }))
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe("RUN_TERMINAL:budget_exhausted")
  })

  it("exposes telemetry records with conservative billable totals", async () => {
    const cfg = makeConfig({ runTotal: 100_000 })
    const ctrl = new TokenBudgetController(cfg)
    const r = await ctrl.reserveRequest(reserveOpts({ model: "test-model", provider: "test-provider" }))
    await ctrl.commitUsage({
      runId: "run-1",
      sessionId: "session-main",
      agentId: "heidi",
      requestId: "req-1",
      reservationId: r.reservationId,
      usage: { input: 100, output: 20, cacheRead: 300 },
      model: "test-model",
      provider: "test-provider",
    })
    const records = ctrl.getUsageRecords()
    expect(records.length).toBeGreaterThanOrEqual(1)
    const committed = records.find(rec => rec.status === "committed")
    expect(committed).toBeDefined()
    expect(committed?.billable).toBe(420)
    expect(committed?.model).toBe("test-model")
    expect(committed?.provider).toBe("test-provider")
  })

  it("cancelSession releases child reservations", async () => {
    const cfg = makeConfig({ runTotal: 100_000, childTotal: 10_000 })
    const ctrl = new TokenBudgetController(cfg)
    ctrl.registerSession("session-child", "child", "session-main")
    const r = await ctrl.reserveRequest(
      reserveOpts({ sessionId: "session-child", agentId: "child", requestId: "req-child", estimatedInputTokens: 5_000, maxOutputTokens: 1_000 }),
    )
    expect(r.allowed).toBe(true)
    const before = ctrl.remainingRun()
    await ctrl.cancelSession("session-child", "cancelled")
    // Reservation released, remaining restored.
    expect(ctrl.remainingRun()).toBeGreaterThan(before)
    expect(ctrl.isSessionTerminal("session-child")).toBe(true)
  })

  it("restores state from durable store", async () => {
    const cfg = makeConfig({ runTotal: 100_000 })
    const store = new InMemoryTokenUsageStore()
    const ctrl = new TokenBudgetController(cfg, { store, runId: "run-restore" })
    const r = await ctrl.reserveRequest(reserveOpts({ runId: "run-restore", estimatedInputTokens: 1_000, maxOutputTokens: 500 }))
    await ctrl.commitUsage({
      runId: "run-restore",
      sessionId: "session-main",
      agentId: "heidi",
      requestId: "req-1",
      reservationId: r.reservationId,
      usage: { input: 300, output: 100 },
    })

    const restored = TokenBudgetController.restore(cfg, "run-restore", store)
    expect(restored.getSnapshot().run.consumed).toBe(400)
    expect(restored.getSnapshot().run.reserved).toBe(0) // committed reservation released
    expect(restored.getUsageRecords().length).toBeGreaterThanOrEqual(1)
  })

  it("derives stable assignment identity for dedup", () => {
    const id1 = TokenBudgetController.assignmentIdentity("run-1", "implementation", "heidi", "scope-a", "sha-1")
    const id2 = TokenBudgetController.assignmentIdentity("run-1", "implementation", "heidi", "scope-a", "sha-1")
    const id3 = TokenBudgetController.assignmentIdentity("run-1", "implementation", "heidi", "scope-b", "sha-1")
    expect(id1).toBe(id2)
    expect(id1).not.toBe(id3)
  })

  it("concurrent reservations do not oversubscribe the run budget", async () => {
    const cfg = makeConfig({ runTotal: 50_000, childTotal: 50_000 })
    const ctrl = new TokenBudgetController(cfg)
    // 20 parallel requests each claiming 3_000 tokens → only 16 can fit in 50_000.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ctrl.reserveRequest(reserveOpts({ requestId: `req-${i}`, estimatedInputTokens: 2_000, maxOutputTokens: 1_000 })),
      ),
    )
    const allowed = results.filter(r => r.allowed).length
    expect(allowed).toBe(16)
    const claimed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.claimed, 0)
    expect(claimed).toBeLessThanOrEqual(50_000)
  })
})