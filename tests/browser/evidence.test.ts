import { describe, it, expect, beforeEach } from "bun:test";
import { AgentBrowserSession } from "../../src/browser/adapter";
import { EvidenceCollector } from "../../src/browser/evidence-collector";
import { FailureDeduplicator } from "../../src/browser/failure-deduplication";

describe("Evidence Collector & Failure Deduplication", () => {
  let session: AgentBrowserSession;
  let collector: EvidenceCollector;

  beforeEach(() => {
    session = new AgentBrowserSession({ mockMode: true });
    collector = new EvidenceCollector();
  });

  it("collects and classifies browser failures", async () => {
    session.addPageError({
      message: "Uncaught TypeError: Cannot read property 'map' of undefined",
      stack: "TypeError: Cannot read property 'map' of undefined\n    at UserList (http://localhost:3000/src/components/UserList.tsx:42:15)",
      timestamp: new Date().toISOString(),
    });

    session.addConsoleEntry({
      type: "error",
      text: "[Fast Refresh] Re-rendering due to HMR update",
      timestamp: new Date().toISOString(),
    });

    const evidence = await collector.collectEvidence(session);
    expect(evidence.hasActionableFailures).toBe(true);
    expect(evidence.failures).toHaveLength(1);
    expect(evidence.failures[0].category).toBe("uncaught-exception");
    expect(evidence.failures[0].classification).toBe("actionable");
  });

  it("deduplicates repeated failures across navigation generations", () => {
    const deduplicator = new FailureDeduplicator();

    const failure1 = {
      fingerprint: "fp-123",
      category: "uncaught-exception" as const,
      message: "Cannot read property 'map' of undefined",
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrences: 1,
      navigationGeneration: 1,
      classification: "actionable" as const,
    };

    // First generation observation
    const res1 = deduplicator.processObservations([failure1], 1);
    expect(res1.activeFailures).toHaveLength(1);
    expect(res1.resolvedFailures).toHaveLength(0);

    // Second generation observation (error resolved!)
    const res2 = deduplicator.processObservations([], 2);
    expect(res2.activeFailures).toHaveLength(0);
    expect(res2.resolvedFailures).toHaveLength(1);
    expect(deduplicator.isResolved("fp-123")).toBe(true);
  });
});
