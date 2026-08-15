import { describe, it, expect } from "bun:test";
import { BrowserRepairCoordinator } from "../../src/browser/repair-coordinator";

describe("BrowserRepairCoordinator", () => {
  it("runs repair workflow in mock mode and returns completion report", async () => {
    const coordinator = new BrowserRepairCoordinator();
    const progressEvents: string[] = [];

    const report = await coordinator.executeRepairWorkflow({
      mockMode: true,
      maxRepairCycles: 2,
      onProgress: (event) => progressEvents.push(event),
    });

    expect(report).toHaveProperty("sessionId");
    expect(report).toHaveProperty("taskId");
    expect(report).toHaveProperty("freshVerificationPassed");
    expect(report.repairCycles).toBeGreaterThanOrEqual(0);
    expect(progressEvents).toContain("repair.started");
    expect(progressEvents).toContain("repair.completed");
  });
});
