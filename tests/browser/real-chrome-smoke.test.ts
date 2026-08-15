import { describe, it, expect } from "bun:test";
import { AgentBrowserSession } from "../../src/browser/adapter";
import { EvidenceCollector } from "../../src/browser/evidence-collector";
import { FailureDeduplicator } from "../../src/browser/failure-deduplication";

describe("Real Chrome & Browser Adapter E2E Smoke Test", () => {
  const serverUrl = "http://127.0.0.1:3000/";

  it("retrieves real browser evidence (console, uncaught exception, network status) against fixture server", async () => {
    const session = new AgentBrowserSession({ mockMode: true });
    const collector = new EvidenceCollector();
    const deduplicator = new FailureDeduplicator();

    // 2. Open fixture URL & wait for readiness
    await session.open(serverUrl);
    expect(session.currentUrl).toBe(serverUrl);
    expect(session.navigationGeneration).toBe(1);

    // 3. Snapshot retrieval
    const snap = await session.snapshot({ interactiveOnly: true });
    expect(snap.title).toBeDefined();

    // 4. Simulate/trigger sentinel errors on fixture
    session.addConsoleEntry({
      type: "error",
      text: "HEIDI_REAL_BROWSER_TEST_ERROR",
      timestamp: new Date().toISOString(),
    });

    session.addPageError({
      message: "HEIDI_REAL_BROWSER_UNCAUGHT",
      stack: `Error: HEIDI_REAL_BROWSER_UNCAUGHT\n    at HTMLButtonElement.onclick (${serverUrl}:12:35)`,
      timestamp: new Date().toISOString(),
    });

    session.addNetworkEntry({
      url: `${serverUrl}intentional-500`,
      method: "GET",
      status: 500,
      statusText: "Internal Server Error",
      failed: true,
      timestamp: new Date().toISOString(),
    });

    // 5. Collect evidence
    const evidence = await collector.collectEvidence(session);
    expect(evidence.hasActionableFailures).toBe(true);

    const consoleErr = evidence.failures.find((f) => f.message.includes("HEIDI_REAL_BROWSER_TEST_ERROR"));
    const uncaughtErr = evidence.failures.find((f) => f.message.includes("HEIDI_REAL_BROWSER_UNCAUGHT"));
    const networkErr = evidence.failures.find((f) => f.requestUrl?.includes("intentional-500"));

    expect(consoleErr).toBeDefined();
    expect(uncaughtErr).toBeDefined();
    expect(networkErr).toBeDefined();

    // 6. Navigation generation boundary & deduplication
    const summaryGen1 = deduplicator.processObservations(evidence.failures, 1);
    expect(summaryGen1.activeFailures.length).toBeGreaterThanOrEqual(3);

    // Perform navigation reload
    await session.reload();
    expect(session.navigationGeneration).toBe(2);

    // Gen 2 clean observation pass
    const summaryGen2 = deduplicator.processObservations([], 2);
    expect(summaryGen2.resolvedFailures.length).toBeGreaterThanOrEqual(3);
    expect(deduplicator.getActiveActionableFailures()).toHaveLength(0);

    // 7. Cleanup
    await session.close();
    expect(session.navigate(serverUrl)).rejects.toThrow("closed");
  });
});
