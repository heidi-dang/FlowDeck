import { describe, expect, it } from "bun:test"
import { resolveTokenBudgetConfig } from "../../src/config/token-budget-config"
import { TokenBudgetController } from "../../src/services/token-budget-controller"
import { InMemoryTokenUsageStore } from "../../src/services/token-usage-store"
import { AdaptiveExecutionControl, detectStall } from "../../src/services/adaptive-execution-control"
describe("adaptive execution control", () => {
  it("detects multi-signal stalls but does not classify one long operation alone", () => { expect(detectStall({ repeatedFailure: 0, repeatedTool: 0, unchangedDiff: 5, repeatedContext: 0, evidenceDelta: 0, tokensSinceProgress: 5000 }).stalled).toBe(false); expect(detectStall({ repeatedFailure: 3, repeatedTool: 0, unchangedDiff: 0, repeatedContext: 0, evidenceDelta: 0, tokensSinceProgress: 700 }).stalled).toBe(true) })
  it("reclaims exactly once and redistributes through the existing controller", async () => { const store = new InMemoryTokenUsageStore(); const ctrl = new TokenBudgetController(resolveTokenBudgetConfig({ enabled: true, runTotal: 1000, childTotal: 500 }), { runId: "run", store }); ctrl.registerSession("s", "agent"); const control = new AdaptiveExecutionControl(ctrl, store); expect(control.reclaimExactlyOnce("run", "r", "w", 300, 100, "completed")).toBe(200); expect(control.reclaimExactlyOnce("run", "r", "w", 300, 100, "duplicate")).toBe(0); const result = await control.redistribute("run", "w2", "s", "agent", 100, "critical_path", "r"); expect(result.allowed).toBe(true); expect(store.read("run").some(e => e.kind === "adaptive_redistribution")).toBe(true) })
})
