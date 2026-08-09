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

  it("restores an uncommitted reservation for restart-safe reconciliation", async () => {
    const cfg = makeConfig({ runTotal: 10_000, childTotal: 5_000 })
    const store = new InMemoryTokenUsageStore()
    const first = new TokenBudgetController(cfg, { store, runId: "run-active" })
    first.registerSession("session-active", "agent")
    const reservation = await first.reserveRequest({ runId: "run-active", sessionId: "session-active", agentId: "agent", requestId: "request-active", estimatedInputTokens: 100, maxOutputTokens: 200 })
    const restored = TokenBudgetController.restore(cfg, "run-active", store)
    expect(restored.getSnapshot().run.reserved).toBe(reservation.claimed)
    const committed = await restored.commitUsage({ runId: "run-active", sessionId: "session-active", agentId: "agent", requestId: "request-active", reservationId: reservation.reservationId, messageId: "message-active", usage: { input: 20, output: 20 } })
    expect(committed.committed).toBe(true)
    expect(committed.releasedUnused).toBe(260)
    expect(restored.getSnapshot().run.reserved).toBe(0)
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

  it("isSessionTerminal returns false for an unregistered session", async () => {
    const cfg = makeConfig({ runTotal: 100_000 })
    const ctrl = new TokenBudgetController(cfg)
    expect(ctrl.isSessionTerminal("never-registered")).toBe(false)
  })

  it("persist() does not write a terminal record", async () => {
    const cfg = makeConfig({ runTotal: 100_000 })
    const store = new InMemoryTokenUsageStore()
    const ctrl = new TokenBudgetController(cfg, { store, runId: "run-persist" })
    ctrl.persist()
    const rebuilt = store.rebuild("run-persist")
    expect(rebuilt.terminal).toBeNull()
    expect(ctrl.isRunTerminal()).toBe(false)
  })

  it("stress: concurrent reserve+commit across sessions never oversubscribes or goes negative", async () => {
    const cfg = makeConfig({ runTotal: 200_000, childTotal: 200_000 })
    const ctrl = new TokenBudgetController(cfg)
    const sessions = ["s-a", "s-b", "s-c", "s-d"]
    const jobs: Promise<void>[] = []
    for (let i = 0; i < 200; i++) {
      const sessionId = sessions[i % sessions.length]
      jobs.push(
        (async () => {
          const r = await ctrl.reserveRequest(
            reserveOpts({
              sessionId,
              requestId: `req-${i}`,
              estimatedInputTokens: 500,
              maxOutputTokens: 200,
            }),
          )
          if (r.allowed) {
            await ctrl.commitUsage({
              runId: "run-1",
              sessionId,
              agentId: "heidi",
              requestId: `req-${i}`,
              reservationId: r.reservationId,
              usage: { input: 300, output: 100 },
            })
          }
        })(),
      )
    }
    await Promise.all(jobs)

    const snap = ctrl.getSnapshot()
    // Accounting invariants: consumed never exceeds ceiling, reserved never negative.
    expect(snap.run.consumed).toBeGreaterThan(0)
    expect(snap.run.consumed).toBeLessThanOrEqual(snap.run.ceiling)
    expect(snap.run.reserved).toBeGreaterThanOrEqual(0)
    expect(snap.remainingRun).toBeGreaterThanOrEqual(0)
    // Every committed record is billable-positive and attributed.
    for (const rec of ctrl.getUsageRecords()) {
      if (rec.status === "committed") {
        expect(rec.billable).toBeGreaterThan(0)
        expect(rec.sessionId).toBeTruthy()
      }
    }
  })

  it("stress: concurrent cancelSession releases all reservations without negative reserved", async () => {
    const cfg = makeConfig({ runTotal: 100_000, childTotal: 100_000 })
    const ctrl = new TokenBudgetController(cfg)
    const reservations: string[] = []
    for (let i = 0; i < 50; i++) {
      const r = await ctrl.reserveRequest(
        reserveOpts({ sessionId: "s-main", requestId: `req-${i}`, estimatedInputTokens: 1_000, maxOutputTokens: 500 }),
      )
      if (r.allowed) reservations.push(r.reservationId)
    }
    expect(reservations.length).toBeGreaterThan(0)
    await ctrl.cancelSession("s-main", "aborted")
    const snap = ctrl.getSnapshot()
    expect(snap.run.reserved).toBe(0)
    expect(snap.remainingRun).toBe(snap.run.ceiling)
  })

  it("provider-matrix: conservative accounting across provider usage shapes", async () => {
    const cfg = makeConfig({ runTotal: 1_000_000, childTotal: 1_000_000 })
    const ctrl = new TokenBudgetController(cfg)

    // Provider A: reports cacheRead + cacheWrite + output (Anthropic-style).
    const rA = await ctrl.reserveRequest(reserveOpts({ requestId: "req-A", estimatedInputTokens: 1_000, maxOutputTokens: 500 }))
    await ctrl.commitUsage({
      runId: "run-1", sessionId: "session-main", agentId: "heidi", requestId: "req-A",
      reservationId: rA.reservationId, usage: { input: 0, output: 200, cacheRead: 4_000, cacheWrite: 100 },
    })

    // Provider B: omits input entirely → must fall back to reserved estimate (never undercount).
    const rB = await ctrl.reserveRequest(reserveOpts({ requestId: "req-B", estimatedInputTokens: 1_000, maxOutputTokens: 500 }))
    await ctrl.commitUsage({
      runId: "run-1", sessionId: "session-main", agentId: "heidi", requestId: "req-B",
      reservationId: rB.reservationId, usage: { output: 50 },
    })

    // Provider C: reasoning tokens exposed separately (OpenAI o-series).
    const rC = await ctrl.reserveRequest(reserveOpts({ requestId: "req-C", estimatedInputTokens: 1_000, maxOutputTokens: 500 }))
    await ctrl.commitUsage({
      runId: "run-1", sessionId: "session-main", agentId: "heidi", requestId: "req-C",
      reservationId: rC.reservationId, usage: { input: 300, output: 100, reasoning: 2_000 },
    })

    const snap = ctrl.getSnapshot()
    // A: 0+200+4000+100 = 4300. B: fallback input 1000 + 50 = 1050. C: 300+100+2000 = 2400.
    expect(snap.run.consumed).toBe(4300 + 1050 + 2400)
    // No reservation leaked.
    expect(snap.run.reserved).toBe(0)
  })

  it("provider-matrix: cache tokens are never double-counted as input", () => {
    const u = normalizeUsage({ input: 100, cacheRead: 300, cacheWrite: 50 })
    // billable counts each component once.
    expect(u.billable).toBe(450)
    expect(u.input).toBe(100)
    expect(u.cacheRead).toBe(300)
  })

  it("adversarial: negative/NaN usage cannot reduce consumed or go negative", async () => {
    const cfg = makeConfig({ runTotal: 100_000 })
    const ctrl = new TokenBudgetController(cfg)
    const r = await ctrl.reserveRequest(reserveOpts({ estimatedInputTokens: 1_000, maxOutputTokens: 500 }))
    await ctrl.commitUsage({
      runId: "run-1", sessionId: "session-main", agentId: "heidi", requestId: "req-1",
      reservationId: r.reservationId,
      usage: { input: -100_000, output: -100_000, cacheRead: -100_000, cacheWrite: -100_000 },
    })
    const snap = ctrl.getSnapshot()
    // Negative usage is clamped to 0; consumed never goes negative.
    expect(snap.run.consumed).toBeGreaterThanOrEqual(0)
    expect(snap.run.reserved).toBeGreaterThanOrEqual(0)
  })

  it("adversarial: oversized estimate is clamped to maxRequestInputTokens", async () => {
    const cfg = makeConfig({ runTotal: 1_000_000, maxRequestInputTokens: 50_000, maxRequestOutputTokens: 10_000 })
    const ctrl = new TokenBudgetController(cfg)
    const r = await ctrl.reserveRequest(
      reserveOpts({ requestId: "req-huge", estimatedInputTokens: 1_000_000_000, maxOutputTokens: 1_000_000_000 }),
    )
    // Clamped to 50_000 + 10_000 = 60_000, well under runTotal.
    expect(r.allowed).toBe(true)
    expect(r.claimed).toBe(60_000)
  })

  it("adversarial: disabled config never blocks dispatch", async () => {
    const cfg = makeConfig({ enabled: false, runTotal: 1, childTotal: 1 })
    const ctrl = new TokenBudgetController(cfg)
    const r = await ctrl.reserveRequest(reserveOpts({ estimatedInputTokens: 1_000_000, maxOutputTokens: 1_000_000 }))
    expect(r.allowed).toBe(true)
    expect(r.disabled).toBe(true)
    expect(r.claimed).toBe(0)
  })

  it("adversarial: terminal run rejects even zero-cost requests", async () => {
    const cfg = makeConfig({ runTotal: 10_000, childTotal: 10_000, hardStopThreshold: 1.0 })
    const ctrl = new TokenBudgetController(cfg)
    const r = await ctrl.reserveRequest(reserveOpts({ estimatedInputTokens: 0, maxOutputTokens: 10_000 }))
    await ctrl.commitUsage({
      runId: "run-1", sessionId: "session-main", agentId: "heidi", requestId: "req-1",
      reservationId: r.reservationId, usage: { input: 10_000, output: 0 },
    })
    expect(ctrl.isRunTerminal()).toBe(true)
    // Even a zero-token request is rejected once terminal.
    const blocked = await ctrl.reserveRequest(reserveOpts({ requestId: "req-0", estimatedInputTokens: 0, maxOutputTokens: 0 }))
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe("RUN_TERMINAL:budget_exhausted")
  })

  it("adversarial: commit without a reservation still charges conservatively", async () => {
    const cfg = makeConfig({ runTotal: 100_000 })
    const ctrl = new TokenBudgetController(cfg)
    // No prior reservation — commitUsage must still account (fallback to 0 input).
    const commit = await ctrl.commitUsage({
      runId: "run-1", sessionId: "session-main", agentId: "heidi", requestId: "req-orphan",
      usage: { output: 50 },
    })
    expect(commit.committed).toBe(true)
    expect(ctrl.getSnapshot().run.consumed).toBe(50)
  })
})
