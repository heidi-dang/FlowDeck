import { describe, it, expect } from "bun:test";
import { V0SpecialistService } from "../../src/browser/v0-specialist";
import { runBrowserChecks } from "../../src/doctor/checks/browser";

describe("v0 Specialist Subsystem", () => {
  it("detects capability status and apiKey missing state safely", () => {
    const v0 = new V0SpecialistService();
    const status = v0.getCapabilityStatus();
    expect(status).toHaveProperty("available");
    expect(status).toHaveProperty("authenticated");
  });

  it("identifies substantial UI tasks requiring redesign", () => {
    const v0 = new V0SpecialistService();
    expect(v0.isSubstantialUiTask("Please redesign the dashboard layout from scratch")).toBe(true);
    expect(v0.isSubstantialUiTask("Fix typo in button text")).toBe(false);
  });

  it("falls back gracefully when v0 is unauthenticated", async () => {
    const v0 = new V0SpecialistService();
    const res = await v0.generateUiProposal({ prompt: "Redesign navbar" });
    expect(res).toHaveProperty("status");
    expect(res.componentName).toBe("GeneratedComponent");
  });
});

describe("Browser Doctor Checks", () => {
  it("runs browser check category without error", async () => {
    const checks = await runBrowserChecks(process.cwd());
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0].id).toBe("browser.capability");
    expect(["pass", "warning"]).toContain(checks[0].status);
  });
});
