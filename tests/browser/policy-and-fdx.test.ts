import { describe, it, expect } from "bun:test";
import { ExplorationPolicy } from "../../src/browser/exploration-policy";
import { FdxSourceCorrelator } from "../../src/browser/fdx-correlation";

describe("Exploration Policy & Destructive Action Safety", () => {
  it("detects destructive actions correctly", () => {
    const policy = new ExplorationPolicy("exploratory");

    expect(policy.isDestructiveAction("Delete User Account")).toBe(true);
    expect(policy.isDestructiveAction("Publish Release")).toBe(true);
    expect(policy.isDestructiveAction("Submit Checkout & Charge Card")).toBe(true);

    expect(policy.isDestructiveAction("View Settings Tab")).toBe(false);
    expect(policy.isDestructiveAction("Filter Search Results")).toBe(false);
  });

  it("filters safe interactive targets and prefers semantic selectors", () => {
    const policy = new ExplorationPolicy("exploratory");

    const targets = [
      { id: "btn-save", role: "button", name: "Save Changes", selector: "#btn-save" },
      { id: "btn-del", role: "button", name: "Delete Account", selector: "#btn-del", isDestructive: true },
    ];

    const safe = policy.filterSafeTargets(targets);
    expect(safe).toHaveLength(1);
    expect(safe[0].name).toBe("Save Changes");

    const sel = policy.selectSemanticTarget(safe[0]);
    expect(sel).toEqual({ semanticId: "btn-save" });
  });

  it("enforces exploration budget limits", () => {
    const policy = new ExplorationPolicy("exploratory", { maxRoutes: 2, maxActions: 2 });
    expect(policy.isBudgetExhausted()).toBe(false);

    policy.recordVisit("http://localhost:3000/r1");
    policy.recordVisit("http://localhost:3000/r2");
    expect(policy.isBudgetExhausted()).toBe(true);
  });
});

describe("FDX Source Correlator", () => {
  it("correlates failure containing stack location", async () => {
    const correlator = new FdxSourceCorrelator();
    const failure = {
      fingerprint: "fp-test",
      category: "uncaught-exception" as const,
      message: "Uncaught TypeError: Cannot read property 'map' of undefined",
      sourceFile: "package.json",
      line: 2,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrences: 1,
      navigationGeneration: 1,
      classification: "actionable" as const,
    };

    const correlated = await correlator.correlateFailure(failure);
    expect(correlated).not.toBeNull();
    expect(correlated?.file).toBe("package.json");
    expect(correlated?.line).toBe(2);
  });
});
