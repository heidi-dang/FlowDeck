import { describe, it, expect } from "bun:test";
import { AgentBrowserSession } from "../../src/browser/adapter";
import { EvidenceCollector } from "../../src/browser/evidence-collector";
import { FailureDeduplicator } from "../../src/browser/failure-deduplication";
import { FdxSourceCorrelator } from "../../src/browser/fdx-correlation";
import { BrowserRepairCoordinator } from "../../src/browser/repair-coordinator";

describe("Browser Debug E2E Fixture Test", () => {
  it("detects console error, uncaught exception, and network failure from simulated app fixture", async () => {
    const session = new AgentBrowserSession({ mockMode: true });
    const collector = new EvidenceCollector();
    const deduplicator = new FailureDeduplicator();
    const correlator = new FdxSourceCorrelator();

    // 1. Simulate application errors
    session.addPageError({
      message: "Uncaught TypeError: Cannot read property 'map' of undefined",
      stack: "TypeError: Cannot read property 'map' of undefined\n    at AgentBrowserSession (src/browser/adapter.ts:42:10)",
      timestamp: new Date().toISOString(),
    });

    session.addConsoleEntry({
      type: "error",
      text: "Failed to load resource: net::ERR_CONNECTION_REFUSED",
      timestamp: new Date().toISOString(),
    });

    session.addNetworkEntry({
      url: "http://localhost:3000/api/users",
      method: "GET",
      status: 500,
      statusText: "Internal Server Error",
      failed: true,
      timestamp: new Date().toISOString(),
    });

    // 2. Collect evidence
    const evidence = await collector.collectEvidence(session);
    expect(evidence.hasActionableFailures).toBe(true);
    expect(evidence.failures.length).toBeGreaterThanOrEqual(2);

    // 3. Deduplicate observations
    const summary = deduplicator.processObservations(evidence.failures, 1);
    expect(summary.activeFailures.length).toBeGreaterThanOrEqual(2);

    // 4. Correlate with source code
    const correlated = await correlator.correlateFailure(summary.activeFailures[0]);
    expect(correlated).not.toBeNull();
    expect(correlated?.file).toBe("src/browser/adapter.ts");

    await session.close();
  });

  it("completes full repair coordinator loop with zero remaining errors on clean state", async () => {
    const coordinator = new BrowserRepairCoordinator();
    const report = await coordinator.executeRepairWorkflow({
      mockMode: true,
      maxRepairCycles: 2,
    });

    expect(report.freshVerificationPassed).toBe(true);
    expect(report.summary).toContain("complete");
  });
});
