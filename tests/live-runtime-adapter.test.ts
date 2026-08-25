import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { FlowDeckLifecycleAdapter } from "../src/runtime/flowdeck-opencode-adapter";
import type { ProductionOrchestrationRuntime } from "../src/orchestration/composition";
import * as router from "../src/services/heidi-fast-router";
import * as routeState from "../src/services/heidi-route-state";
import {
  repoMasterAdviceFromRoutingDecision,
  specialistPlanFromRoutingDecision,
} from "../src/orchestration/routing/fast-router-adapter";

function repoAdvice(runId = "run-123") {
  return {
    version: "1.0.0" as const,
    requestId: "f".repeat(64),
    runId,
    repository: {
      repositoryId: "a".repeat(64),
      root: "/mock/dir",
      headSha: "1234567890abcdef1234567890abcdef12345678",
      branch: "main",
      dirtyFingerprint: "b".repeat(64),
      packageFingerprint: "c".repeat(64),
      configFingerprint: "d".repeat(64),
      fingerprint: "e".repeat(64),
    },
    executionMode: "MULTI_SPECIALIST" as const,
    scope: ["src/auth.ts"],
    relevantPackages: ["package.json"],
    relevantFiles: ["src/auth.ts"],
    dependencyEdges: [],
    likelyTests: ["tests/auth.test.ts"],
    architecturalConstraints: ["Preserve authoritative lifecycle boundaries."],
    riskAreas: ["Authentication changes are security-sensitive."],
    suggestedSpecialistCapabilities: ["SECURITY"] as const,
    confidence: 0.8,
    evidenceSources: ["fdx_workspace_index"],
    generatedAt: "2026-08-25T00:00:00.000Z",
  };
}

function lifecycleRuntime(overrides: Record<string, unknown> = {}) {
  const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-123" });
  const mockBindActiveRun = vi.fn();
  const mockSaveDecision = vi.fn();
  return {
    services: {
      runService: { createRun: mockCreateRun },
      runRepo: { findById: vi.fn() },
    },
    routingDecisionRepository: {
      saveDecision: mockSaveDecision,
      getLatestDecisionForRun: vi.fn(),
    },
    sessionRepo: {
      findById: vi.fn().mockReturnValue(null),
      bindActiveRun: mockBindActiveRun,
    },
    metrics: { recordSpecialistPlan: vi.fn() },
    ...overrides,
  } as unknown as ProductionOrchestrationRuntime;
}

function userTurn(sessionID: string, text: string) {
  return {
    message: {} as any,
    parts: [{ type: "text", text, id: "1", sessionID, messageID: "1" }],
  } as any;
}

beforeEach(() => routeState._resetRouteState());
afterEach(() => vi.restoreAllMocks());

describe("FlowDeckLifecycleAdapter", () => {
  it("creates a Run, canonical RoutingDecision, and binds session affinity", async () => {
    const mockRuntime = lifecycleRuntime();
    const mockCreateRun = mockRuntime.services.runService.createRun as ReturnType<typeof vi.fn>;
    const mockBindActiveRun = mockRuntime.sessionRepo.bindActiveRun as ReturnType<typeof vi.fn>;
    const mockSaveDecision = mockRuntime.routingDecisionRepository.saveDecision as ReturnType<typeof vi.fn>;
    const adapter = new FlowDeckLifecycleAdapter("/mock/dir", mockRuntime);

    vi.spyOn(router, "classifyTask").mockReturnValue({
      executionClass: "STANDARD",
      reason: "Mock",
      reasonCode: "MOCK",
      confidence: 1,
      forcedByExplicitSignal: false,
      mcpCompositionCandidate: false,
      codeModeRejectedReason: undefined,
      codeModeTelemetry: { codeModeConsidered: true, codeModeSelected: false, codeModeRejectedReason: undefined },
    });

    await adapter.onChatMessage({ sessionID: "sess-affinity-1", agent: "heidi" }, userTurn("sess-affinity-1", "do a huge refactor"));

    expect(mockCreateRun).toHaveBeenCalled();
    const args = mockCreateRun.mock.calls[0][0];
    expect(args.runType).toBe("planned");
    expect(args.sessionId).toBe("sess-affinity-1");
    expect(args.metadata.goal).toBe("do a huge refactor");
    expect(mockSaveDecision).toHaveBeenCalled();
    expect(mockBindActiveRun).toHaveBeenCalledWith({ id: "sess-affinity-1", runId: "run-123", agentId: "heidi", status: "running" });
  });

  it("skips Repo Master and durable orchestration for direct work", async () => {
    const consult = vi.fn();
    const mockRuntime = lifecycleRuntime({ repoMaster: { consult, isAdviceFresh: vi.fn() } });
    const adapter = new FlowDeckLifecycleAdapter("/mock/dir", mockRuntime);
    vi.spyOn(router, "classifyTask").mockReturnValue({
      executionClass: "FAST_DIRECT",
      executionMode: "DIRECT",
      reason: "bounded local task",
      reasonCode: "DIRECT",
      confidence: 1,
      forcedByExplicitSignal: false,
    });

    await adapter.onChatMessage({ sessionID: "direct-1", agent: "heidi" }, userTurn("direct-1", "Fix a typo"));

    expect(consult).not.toHaveBeenCalled();
    expect(mockRuntime.services.runService.createRun).not.toHaveBeenCalled();
    expect(mockRuntime.routingDecisionRepository.saveDecision).not.toHaveBeenCalled();
  });

  it("persists bounded advice for a required multi-specialist consultation while SpecialistPlan retains capability authority", async () => {
    const consult = vi.fn().mockReturnValue({ advice: repoAdvice(), cacheHit: false, refreshed: true });
    const mockRuntime = lifecycleRuntime({ repoMaster: { consult, isAdviceFresh: vi.fn().mockReturnValue(true) } });
    const adapter = new FlowDeckLifecycleAdapter("/mock/dir", mockRuntime);
    vi.spyOn(router, "classifyTask").mockReturnValue({
      executionClass: "PARALLEL_SPECIALISTS",
      executionMode: "MULTI_SPECIALIST",
      specialists: ["BACKEND", "UI"],
      suggestedAgents: ["backend-coder", "frontend-coder"],
      reason: "Independent API and UI work.",
      reasonCode: "PARALLEL_UI_BACKEND",
      confidence: 0.9,
      forcedByExplicitSignal: false,
    });

    await adapter.onChatMessage({ sessionID: "complex-1", agent: "heidi" }, userTurn("complex-1", "Coordinate API and UI changes"));

    expect(consult).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-123", executionMode: "MULTI_SPECIALIST" }));
    const persisted = (mockRuntime.routingDecisionRepository.saveDecision as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(repoMasterAdviceFromRoutingDecision(persisted)?.requestId).toBe("f".repeat(64));
    const plan = specialistPlanFromRoutingDecision(persisted);
    expect(plan?.specs.map(spec => spec.capability).sort()).toEqual(["BACKEND", "UI"]);
    expect(plan?.specs.every(spec => spec.scope.includes("src/auth.ts"))).toBe(true);
    expect(plan?.specs.some(spec => spec.capability === "SECURITY")).toBe(false);
  });

  it("blocks required multi-specialist routing when advisory consultation fails instead of persisting invented evidence", async () => {
    const mockRuntime = lifecycleRuntime({ repoMaster: { consult: vi.fn(() => { throw new Error("index unavailable"); }), isAdviceFresh: vi.fn() } });
    const adapter = new FlowDeckLifecycleAdapter("/mock/dir", mockRuntime);
    vi.spyOn(router, "classifyTask").mockReturnValue({
      executionClass: "PARALLEL_SPECIALISTS",
      executionMode: "MULTI_SPECIALIST",
      specialists: ["BACKEND", "UI"],
      suggestedAgents: ["backend-coder", "frontend-coder"],
      reason: "Independent API and UI work.",
      reasonCode: "PARALLEL_UI_BACKEND",
      confidence: 0.9,
      forcedByExplicitSignal: false,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await adapter.onChatMessage({ sessionID: "blocked-1", agent: "heidi" }, userTurn("blocked-1", "Coordinate API and UI changes"));

    expect(mockRuntime.routingDecisionRepository.saveDecision).not.toHaveBeenCalled();
    expect(mockRuntime.sessionRepo.bindActiveRun).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[FlowDeckLifecycleAdapter] syncOrchestrationRun failed:", expect.objectContaining({ message: expect.stringContaining("REPO_MASTER_REQUIRED_CONSULTATION_FAILED") }));
  });

  it("hydrates session state from database routing decision", async () => {
    const mockRuntime = {
      services: {
        runService: { createRun: vi.fn(), updateRun: vi.fn() },
        runRepo: { findById: vi.fn().mockResolvedValue({ id: "run-456", runType: "delegated", status: "running" }) },
      },
      routingDecisionRepository: {
        getLatestDecisionForRun: vi.fn().mockReturnValue({
          routingDecisionId: "rd-456", runId: "run-456", decisionVersion: 1,
          sourceSha: "0000000000000000000000000000000000000000", strategy: "parallel_implementation",
          delegate: true, delegations: [], workstreams: [], budgetRecommendation: "normal", modelRecommendation: "default",
          rationale: ["Parallel UI and Backend required"], rejectedAlternatives: [], policyVersion: "2.0.0", createdAt: new Date().toISOString(), finalized: true,
          assessment: {
            assessmentId: "assess-456", runId: "run-456", taskClass: "feature",
            complexity: { score: 88, evidence: [{ id: "ev1", kind: "score", signal: "primary", value: "0.88", weight: 100 }] },
            ambiguity: { score: 10, evidence: [{ id: "ev2", kind: "score", signal: "primary", value: "0.1", weight: 100 }] },
            risk: { score: 10, evidence: [{ id: "ev3", kind: "score", signal: "primary", value: "0.1", weight: 100 }] },
            parallelism: "high",
            evidence: [
              { id: "ev-execution-class", kind: "classification", signal: "executionClass", value: "PARALLEL_SPECIALISTS", weight: 100 },
              { id: "ev-user-goal", kind: "goal", signal: "goal", value: "hydrated goal", weight: 100 },
              { id: "ev-message-hash", kind: "hash", signal: "lastUserMessageHash", value: "hash123", weight: 100 },
              { id: "ev-reason-code", kind: "classification", signal: "reasonCode", value: "PARALLEL_DOMAIN_OVERLAP", weight: 100 },
              { id: "ev-confidence", kind: "classification", signal: "confidence", value: "0.95", weight: 100 },
              { id: "ev-forced-signal", kind: "classification", signal: "forcedByExplicitSignal", value: "false", weight: 100 },
            ],
            classifierVersion: "2.0.0", policyVersion: "2.0.0", createdAt: new Date().toISOString(),
          },
        }),
      },
      sessionRepo: {
        findById: vi.fn().mockReturnValue({ id: "sess-hydrate-1", runId: "run-456" }),
        bindActiveRun: vi.fn(),
      },
    } as unknown as ProductionOrchestrationRuntime;

    const adapter = new FlowDeckLifecycleAdapter("/mock/dir", mockRuntime);
    vi.spyOn(router, "stableHash").mockReturnValue("hash123");
    await adapter.onChatMessage({ sessionID: "sess-hydrate-1", agent: "heidi" }, userTurn("sess-hydrate-1", "do a huge refactor"));

    const decision = routeState.getRouteDecision("sess-hydrate-1");
    expect(decision).not.toBeNull();
    expect(decision?.decision.executionClass).toBe("PARALLEL_SPECIALISTS");
    expect(decision?.goal).toBe("hydrated goal");
    expect(decision?.continuationCount).toBe(1);
  });
});
