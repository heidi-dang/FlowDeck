import { describe, it, expect, vi } from "vitest";
import { FlowDeckLifecycleAdapter } from "../src/runtime/flowdeck-opencode-adapter";
import type { ProductionOrchestrationRuntime } from "../src/orchestration/composition";
import * as router from "../src/services/heidi-fast-router";
import * as routeState from "../src/services/heidi-route-state";

describe("FlowDeckLifecycleAdapter", () => {
  it("creates a Run, canonical RoutingDecision, and binds session affinity", async () => {
    const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-123" });
    const mockBindActiveRun = vi.fn();
    const mockSaveDecision = vi.fn();
    
    const mockRuntime = {
      services: {
        runService: { createRun: mockCreateRun },
        runRepo: { findById: vi.fn() }
      },
      routingDecisionRepository: {
        saveDecision: mockSaveDecision,
        getLatestDecisionForRun: vi.fn()
      },
      sessionRepo: {
        findById: vi.fn().mockReturnValue(null),
        bindActiveRun: mockBindActiveRun
      }
    } as unknown as ProductionOrchestrationRuntime;

    const adapter = new FlowDeckLifecycleAdapter("/mock/dir", mockRuntime);
    
    vi.spyOn(router, "classifyTask").mockReturnValue({
      executionClass: "STANDARD",
      reason: "Mock",
      reasonCode: "MOCK",
      confidence: 1,
      forcedByExplicitSignal: false,
      mcpCompositionCandidate: false,
      codeModeRejectedReason: undefined,
      codeModeTelemetry: {
        codeModeConsidered: true,
        codeModeSelected: false,
        codeModeRejectedReason: undefined
      }
    });

    await adapter.onChatMessage(
      { sessionID: "sess-affinity-1", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "do a huge refactor", id: "1", sessionID: "sess-affinity-1", messageID: "1" }] }
    );

    expect(mockCreateRun).toHaveBeenCalled();
    const args = mockCreateRun.mock.calls[0][0];
    expect(args.runType).toBe("planned");
    expect(args.sessionId).toBe("sess-affinity-1");
    expect(args.metadata.goal).toBe("do a huge refactor");

    expect(mockSaveDecision).toHaveBeenCalled();
    expect(mockBindActiveRun).toHaveBeenCalledWith({
      id: "sess-affinity-1",
      runId: "run-123",
      agentId: "heidi",
      status: "running"
    });
  });

  it("hydrates session state from database routing decision", async () => {
    const mockRuntime = {
      services: {
        runService: { createRun: vi.fn(), updateRun: vi.fn() },
        runRepo: {
          findById: vi.fn().mockResolvedValue({
            id: "run-456",
            runType: "delegated",
            status: "running",
          })
        }
      },
      routingDecisionRepository: {
        getLatestDecisionForRun: vi.fn().mockReturnValue({
          routingDecisionId: "rd-456",
          runId: "run-456",
          decisionVersion: 1,
          sourceSha: "0000000000000000000000000000000000000000",
          strategy: "parallel_implementation",
          delegate: true,
          delegations: [],
          workstreams: [],
          budgetRecommendation: "normal",
          modelRecommendation: "default",
          rationale: ["Parallel UI and Backend required"],
          rejectedAlternatives: [],
          policyVersion: "2.0.0",
          createdAt: new Date().toISOString(),
          finalized: true,
          assessment: {
            assessmentId: "assess-456",
            runId: "run-456",
            taskClass: "feature",
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
            classifierVersion: "2.0.0",
            policyVersion: "2.0.0",
            createdAt: new Date().toISOString(),
          }
        })
      },
      sessionRepo: {
        findById: vi.fn().mockReturnValue({
          id: "sess-hydrate-1",
          runId: "run-456"
        }),
        bindActiveRun: vi.fn()
      }
    } as unknown as ProductionOrchestrationRuntime;

    // Reset memory
    routeState._resetRouteState();

    const adapter = new FlowDeckLifecycleAdapter("/mock/dir", mockRuntime);
    
    // Send a message that matches the hydrated hash
    vi.spyOn(router, "stableHash").mockReturnValue("hash123");

    await adapter.onChatMessage(
      { sessionID: "sess-hydrate-1", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "do a huge refactor", id: "1", sessionID: "sess-hydrate-1", messageID: "1" }] }
    );

    const decision = routeState.getRouteDecision("sess-hydrate-1");
    expect(decision).not.toBeNull();
    expect(decision?.decision.executionClass).toBe("PARALLEL_SPECIALISTS");
    expect(decision?.goal).toBe("hydrated goal");
    expect(decision?.continuationCount).toBe(1); // Because it was preserved!
  });
});
