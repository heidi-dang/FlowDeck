import { describe, it, expect } from "bun:test";
import { AgentBrowserSession } from "../../src/browser/adapter";
import { FailureDeduplicator } from "../../src/browser/failure-deduplication";
import { BrowserRepairCoordinator } from "../../src/browser/repair-coordinator";

describe("Concurrent Browser Debugging Tasks Isolation", () => {
  it("isolates independent browser sessions, failure buffers, and repair state", async () => {
    const sessionA = new AgentBrowserSession({ mockMode: true, taskId: "task-A" });
    const sessionB = new AgentBrowserSession({ mockMode: true, taskId: "task-B" });

    const dedupA = new FailureDeduplicator();
    const dedupB = new FailureDeduplicator();

    // Session A records error A
    const failA = {
      fingerprint: "fp-err-A",
      category: "uncaught-exception" as const,
      message: "Error in Task A",
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrences: 1,
      navigationGeneration: 1,
      classification: "actionable" as const,
    };
    dedupA.processObservations([failA], 1);

    // Session B records error B
    const failB = {
      fingerprint: "fp-err-B",
      category: "console-error" as const,
      message: "Error in Task B",
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrences: 1,
      navigationGeneration: 1,
      classification: "actionable" as const,
    };
    dedupB.processObservations([failB], 1);

    // Verify task A and task B evidence stores are isolated
    expect(dedupA.getActiveActionableFailures()).toHaveLength(1);
    expect(dedupA.getActiveActionableFailures()[0].fingerprint).toBe("fp-err-A");

    expect(dedupB.getActiveActionableFailures()).toHaveLength(1);
    expect(dedupB.getActiveActionableFailures()[0].fingerprint).toBe("fp-err-B");

    // Close session A
    await sessionA.close();
    expect(sessionA.navigate("http://localhost:3000")).rejects.toThrow();

    // Session B remains open and unaffected
    await sessionB.navigate("http://localhost:3000/dashboard");
    expect(sessionB.currentUrl).toBe("http://localhost:3000/dashboard");

    await sessionB.close();
  });

  it("runs two repair workflows concurrently without interference", async () => {
    const coordinator = new BrowserRepairCoordinator();

    const [reportA, reportB] = await Promise.all([
      coordinator.executeRepairWorkflow({ taskId: "task-101", mockMode: true, maxRepairCycles: 1 }),
      coordinator.executeRepairWorkflow({ taskId: "task-102", mockMode: true, maxRepairCycles: 1 }),
    ]);

    expect(reportA.taskId).toBe("task-101");
    expect(reportB.taskId).toBe("task-102");
    expect(reportA.sessionId).not.toBe(reportB.sessionId);
  });
});
