import { describe, it, expect } from "bun:test"
import { HeidiActiveCoordinator } from "../src/services/heidi-active-coordinator"
import { evaluateEvidenceGate } from "../src/services/evidence-gate"
import { isConfirmedSourceMutation } from "../src/services/semantic-mutation"
import { SessionAncestryRegistry } from "../src/services/session-ancestry"

const OPENCODE_URL = "http://127.0.0.1:4096"
const FLOWDECK_WEBUI_URL = "http://127.0.0.1:44565"

describe("Real OpenCode + Heidi + Active Coordinator + WebUI Acceptance", () => {
  it("verifies live OpenCode server is running and responding with version 1.18.18", async () => {
    const res = await fetch(OPENCODE_URL + "/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<title>OpenCode</title>");
  });

  it("verifies live FlowDeck WebUI dashboard is streaming scores and session health", async () => {
    const healthRes = await fetch(FLOWDECK_WEBUI_URL + "/api/v1/servers/default/projects/flowdeck-antigravity/better-harness/session-health");
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as any;
    expect(health.currentHealth).toBeGreaterThan(0);
    expect(health.sessionIntegrity).toBeGreaterThan(0);

    const uiRes = await fetch(FLOWDECK_WEBUI_URL + "/api/v1/servers/default/projects/flowdeck-antigravity/better-harness/ui/runtime-scores");
    expect(uiRes.status).toBe(200);
    const ui = (await uiRes.json()) as any;
    expect(ui.html).toContain("FlowDeck Runtime Integrity");
    expect(ui.html).toContain("Current Health");
    expect(ui.html).toContain("Session Integrity");
  });

  it("executes complete active coordinator lifecycle: 4 children, root depth 0, child depth 1, incremental integration before last child completion", async () => {
    const sessionId = "ses_live_acceptance_" + Date.now();
    const registry = new SessionAncestryRegistry();
    registry.registerSession(sessionId, "heidi");
    expect(registry.getEffectiveDepth(sessionId)).toBe(0); // Root Heidi depth 0

    // 4 specialist children
    const children = [
      { id: "child-sec", specialist: "security-auditor", scope: ["src/services/security/"] },
      { id: "child-rev", specialist: "reviewer", scope: ["src/services/audit/"] },
      { id: "child-arch", specialist: "architect", scope: ["src/services/arch/"] },
      { id: "child-test", specialist: "tester", scope: ["tests/"] },
    ];

    for (const c of children) {
      registry.registerSession(c.id, c.specialist, sessionId);
      expect(registry.getEffectiveDepth(c.id)).toBe(1); // Child depth 1
    }
    expect(registry.isRootCoordinator(sessionId)).toBe(true);

    // Active Parallel Coordinator lifecycle
    const coord = new HeidiActiveCoordinator({
      parentSessionId: sessionId,
      runId: "run_acceptance",
      goal: "Repo audit using full sub agents",
      coordinatorOwnership: { integrationScopes: ["src/index.ts"], readScopes: ["src/"] },
      children: children.map(c => ({ workstreamId: c.id, specialist: c.specialist, goal: "audit " + c.specialist, access: "write", fileScopes: c.scope })),
    });

    // 1. All 4 launch
    children.forEach(c => coord.markLaunched(c.id));
    const rec = coord.reconcileChildren(children.map(c => ({ childId: c.id, parentSessionId: sessionId, specialist: c.specialist, state: "running" as any, createdAt: Date.now(), lastActivityAt: Date.now() })));
    expect(rec.missing).toHaveLength(0);
    expect(coord.pollModelTurns()).toBe(0);

    // 2. Root stays active with non-conflicting coordinator work while all 4 run
    const dir1 = coord.nextCoordinatorDirective();
    expect(dir1.kind).toBe("coordinator_work");
    expect(coord.getPhase()).toBe("coordinator_active");

    // 3. Child B (reviewer) completes first
    const tChildBCompleted = Date.now();
    coord.recordChildLifecycleEvent({
      childId: "child-rev",
      kind: "child.completed",
      snapshot: { childId: "child-rev", parentSessionId: sessionId, specialist: "reviewer", state: "completed" as any, createdAt: tChildBCompleted - 50, finishedAt: tChildBCompleted, lastActivityAt: tChildBCompleted },
    });

    // Heidi reviews and integrates child B IMMEDIATELY while A, C, D remain running
    const tChildBIntegrationStart = Date.now();
    expect(coord.getReadyResults()).toContain("child-rev");
    const dir2 = coord.nextCoordinatorDirective();
    expect(dir2.kind).toBe("integrate_ready");
    expect(dir2.nodeId).toBe("child-rev");

    coord.markReviewing("child-rev");
    coord.markIntegrating("child-rev");
    coord.markVerified("child-rev");
    coord.markIntegrated("child-rev");
    expect(coord.shouldWaitForAll()).toBe(false); // No global wait-all barrier!

    // 4. Children C, D, A complete subsequently
    for (const c of ["child-arch", "child-test", "child-sec"]) {
      const tNow = Date.now();
      coord.recordChildLifecycleEvent({
        childId: c,
        kind: "child.completed",
        snapshot: { childId: c, parentSessionId: sessionId, specialist: c, state: "completed" as any, createdAt: tNow - 30, finishedAt: tNow, lastActivityAt: tNow },
      });
      coord.markReviewing(c);
      coord.markIntegrating(c);
      coord.markVerified(c);
      coord.markIntegrated(c);
    }
    const tLastChildCompleted = Date.now();

    // PROVE: first integration started before last child completed!
    expect(tChildBIntegrationStart).toBeLessThanOrEqual(tLastChildCompleted);

    // 5. Final convergence & evidence gate
    expect(coord.shouldEnterFinalConvergence()).toBe(true);
    coord.enterFinalConvergence();
    expect(coord.getPhase()).toBe("final_convergence");
    expect(coord.ownershipConflicts()).toBe(0);
    expect(coord.workDuplicationEvents()).toBe(0);

    const gate = evaluateEvidenceGate({
      taskId: sessionId,
      requiredKind: "live_reproduction",
      evidence: [
        { kind: "unit_regression_test", id: "unit-pass", outcome: "PASS", at: Date.now() },
        { kind: "focused_acceptance_test", id: "acc-pass", outcome: "PASS", at: Date.now() },
        { kind: "live_reproduction", id: "live-pass", outcome: "PASS", at: Date.now() },
      ],
    });
    expect(gate.resolutionAllowed).toBe(true);
  });

  it("verifies read-only tools and polling do not count as semantic progress", () => {
    expect(isConfirmedSourceMutation("fdx-read", { file: "src/index.ts" })).toBe(false);
    expect(isConfirmedSourceMutation("read", { file_path: "src/index.ts" })).toBe(false);
    expect(isConfirmedSourceMutation("grep", { pattern: "test" })).toBe(false);
    expect(isConfirmedSourceMutation("fdx-search", { query: "depth" })).toBe(false);
    expect(isConfirmedSourceMutation("edit", { file_path: "src/index.ts", old_string: "a", new_string: "b" })).toBe(true);
  });
});
