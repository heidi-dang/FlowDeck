import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { classifyBrowserDebugIntent } from "../../src/lib/task-routing";
import { getCanonicalAgent } from "../../src/services/canonical-registry";
import { BrowserRepairCoordinator } from "../../src/browser/repair-coordinator";
import { AgentBrowserSession } from "../../src/browser/adapter";
import { EvidenceCollector } from "../../src/browser/evidence-collector";
import { FailureDeduplicator } from "../../src/browser/failure-deduplication";
import { FdxSourceCorrelator } from "../../src/browser/fdx-correlation";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("Heidi Closed-Loop Autonomous Repair E2E", () => {
  const tempFixturePath = join(process.cwd(), "src", "temp-broken-component.tsx");

  beforeEach(() => {
    // Inject a deliberate frontend component defect on disk
    const brokenCode = `
import React from 'react';

export function TempBrokenComponent() {
  const data: any = undefined;
  // Deliberate runtime error
  return <div>{data.items.map((i: any) => <span key={i}>{i}</span>)}</div>;
}
`;
    writeFileSync(tempFixturePath, brokenCode);
  });

  afterEach(() => {
    try {
      if (existsSync(tempFixturePath)) unlinkSync(tempFixturePath);
    } catch {
      /* ignore */
    }
  });

  it("executes complete user workflow 'Fix all console bugs' end-to-end", async () => {
    const userPrompt = "Fix all console bugs";

    // 1. Natural Language Intent Classification
    const intentResult = classifyBrowserDebugIntent(userPrompt);
    expect(intentResult.isBrowserDebug).toBe(true);
    expect(intentResult.intent?.operation).toBe("debug-and-repair");

    // 2. Canonical Agent Resolution
    const agent = getCanonicalAgent("browser-debugger");
    expect(agent).not.toBeNull();
    expect(agent?.allowedTaskTypes).toContain("browser-debug");

    // 3. Simulated Browser Session & Evidence Collection
    const session = new AgentBrowserSession({ mockMode: true, taskId: "e2e-task" });
    await session.open("http://localhost:3000/broken-view");

    session.addPageError({
      message: "Uncaught TypeError: Cannot read property 'items' of undefined",
      stack: `TypeError: Cannot read property 'items' of undefined\n    at TempBrokenComponent (${tempFixturePath}:7:20)`,
      timestamp: new Date().toISOString(),
    });

    const collector = new EvidenceCollector();
    const evidence = await collector.collectEvidence(session);
    expect(evidence.hasActionableFailures).toBe(true);

    const deduplicator = new FailureDeduplicator();
    const summary = deduplicator.processObservations(evidence.failures, 1);
    expect(summary.activeFailures).toHaveLength(1);

    // 4. FDX Source Correlation
    const correlator = new FdxSourceCorrelator();
    const correlated = await correlator.correlateFailure(summary.activeFailures[0]);
    expect(correlated).not.toBeNull();
    expect(correlated?.file.replace(/\\/g, "/")).toBe("src/temp-broken-component.tsx");

    // 5. Autonomous Repair Edit Handler
    let editApplied = false;
    const applyEdit = async () => {
      const fixedCode = `
import React from 'react';

export function TempBrokenComponent() {
  const data = { items: [1, 2, 3] };
  return <div>{data.items.map((i) => <span key={i}>{i}</span>)}</div>;
}
`;
      writeFileSync(tempFixturePath, fixedCode);
      editApplied = true;
      return true;
    };

    // 6. Execute Autonomous Repair Loop via Coordinator
    const coordinator = new BrowserRepairCoordinator();
    const report = await coordinator.executeRepairWorkflow({
      taskId: "e2e-task",
      mockMode: true,
      mockFailures: summary.activeFailures,
      maxRepairCycles: 2,
      applyRepairEdit: applyEdit,
    });

    expect(editApplied).toBe(true);
    expect(report.freshVerificationPassed).toBe(true);
    expect(report.actionableDefectsFound).toBe(1);
    expect(report.summary).toContain("complete");

    await session.close();
  });
});
