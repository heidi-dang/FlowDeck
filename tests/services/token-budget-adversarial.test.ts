import { describe, it, expect } from "bun:test"
import { TokenBudgetController } from "../../src/services/token-budget-controller"
import { resolveTokenBudgetConfig } from "../../src/config/token-budget-config"
import { InMemoryTokenUsageStore } from "../../src/services/token-usage-store"

/**
 * Adversarial simulation: a run with many concurrent agents each issuing many
 * requests must NEVER oversubscribe the run ceiling, and must hard-stop once
 * the ceiling is reached. This is the regression guard for the 10M-token
 * runaway: without a pre-dispatch atomic reservation gate, concurrent agents
 * can collectively blow past the budget.
 */
describe("adversarial token-budget simulation", () => {
  it("never oversubscribes the run ceiling under concurrent load", async () => {
    const cfg = resolveTokenBudgetConfig({
      enabled: true,
      profile: "small",
      runTotal: 100_000,
      childTotal: 40_000,
      warningThreshold: 0.8,
      hardStopThreshold: 1.0,
    })
    const store = new InMemoryTokenUsageStore()
    const ctrl = new TokenBudgetController(cfg, { store, runId: "adversarial-run" })

    const agents = ["heidi", "backend", "frontend", "reviewer", "tester"]
    const requestsPerAgent = 40
    const perRequest = 3_000 // each request claims 3000 tokens

    // Register child sessions.
    for (const a of agents.slice(1)) {
      ctrl.registerSession(`session-${a}`, a, "session-heidi")
    }

    // Fire all reservations concurrently.
    const reservations = await Promise.all(
      agents.flatMap((a, ai) =>
        Array.from({ length: requestsPerAgent }, (_, i) =>
          ctrl.reserveRequest({
            runId: "adversarial-run",
            sessionId: ai === 0 ? "session-heidi" : `session-${a}`,
            agentId: a,
            parentSessionId: ai === 0 ? undefined : "session-heidi",
            requestId: `${a}-${i}`,
            estimatedInputTokens: perRequest,
            maxOutputTokens: 0,
          }),
        ),
      ),
    )

    const allowed = reservations.filter(r => r.allowed)
    const rejected = reservations.filter(r => !r.allowed)

    // Total claimed must never exceed the run ceiling.
    const totalClaimed = allowed.reduce((sum, r) => sum + r.claimed, 0)
    expect(totalClaimed).toBeLessThanOrEqual(cfg.runTotal)

    // Some requests must be rejected (budget is finite).
    expect(rejected.length).toBeGreaterThan(0)
    expect(rejected.every(r => r.reason === "BUDGET_EXHAUSTED" || r.reason === "CHILD_BUDGET_EXHAUSTED")).toBe(true)

    // Remaining run is never negative.
    expect(ctrl.remainingRun()).toBeGreaterThanOrEqual(0)
  })

  it("hard-stops and blocks all further dispatch once ceiling reached", async () => {
    const cfg = resolveTokenBudgetConfig({
      enabled: true,
      profile: "small",
      runTotal: 10_000,
      childTotal: 10_000,
      hardStopThreshold: 1.0,
    })
    const ctrl = new TokenBudgetController(cfg)

    // Consume the full budget.
    const r = await ctrl.reserveRequest({
      runId: "run",
      sessionId: "s",
      agentId: "heidi",
      requestId: "req-1",
      estimatedInputTokens: 10_000,
      maxOutputTokens: 0,
    })
    expect(r.allowed).toBe(true)
    await ctrl.commitUsage({
      runId: "run",
      sessionId: "s",
      agentId: "heidi",
      requestId: "req-1",
      reservationId: r.reservationId,
      usage: { input: 10_000, output: 0 },
    })

    expect(ctrl.isRunTerminal()).toBe(true)

    // Any further dispatch is blocked with RUN_TERMINAL.
    const blocked = await ctrl.reserveRequest({
      runId: "run",
      sessionId: "s",
      agentId: "heidi",
      requestId: "req-2",
      estimatedInputTokens: 100,
      maxOutputTokens: 0,
    })
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe("RUN_TERMINAL:budget_exhausted")
  })

  it("child budget is enforced independently of the run budget", async () => {
    const cfg = resolveTokenBudgetConfig({
      enabled: true,
      profile: "small",
      runTotal: 100_000,
      childTotal: 5_000,
    })
    const ctrl = new TokenBudgetController(cfg)
    ctrl.registerSession("session-child", "child", "session-main")

    // Child exhausts its own 5000 ceiling.
    const r1 = await ctrl.reserveRequest({
      runId: "run",
      sessionId: "session-child",
      agentId: "child",
      parentSessionId: "session-main",
      requestId: "c-1",
      estimatedInputTokens: 5_000,
      maxOutputTokens: 0,
    })
    expect(r1.allowed).toBe(true)

    // Child is now blocked by its own ceiling.
    const r2 = await ctrl.reserveRequest({
      runId: "run",
      sessionId: "session-child",
      agentId: "child",
      parentSessionId: "session-main",
      requestId: "c-2",
      estimatedInputTokens: 100,
      maxOutputTokens: 0,
    })
    expect(r2.allowed).toBe(false)
    expect(r2.reason).toBe("CHILD_BUDGET_EXHAUSTED")

    // Parent still has plenty of run budget.
    const parent = await ctrl.reserveRequest({
      runId: "run",
      sessionId: "session-main",
      agentId: "heidi",
      requestId: "p-1",
      estimatedInputTokens: 1_000,
      maxOutputTokens: 0,
    })
    expect(parent.allowed).toBe(true)
  })
})