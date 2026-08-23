import { describe, it, expect, vi } from "vitest";
import { FlowDeckLifecycleAdapter } from "../src/runtime/flowdeck-opencode-adapter";
import type { ProductionOrchestrationRuntime } from "../src/orchestration/composition";
import * as router from "../src/services/heidi-fast-router";
import * as routeState from "../src/services/heidi-route-state";

describe("FlowDeckLifecycleAdapter", () => {
  it("creates a Run and maintains session affinity", async () => {
    const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-123" });
    const mockFindById = vi.fn().mockReturnValue(null);
    const mockCreateSession = vi.fn();
    
    const mockRuntime = {
      services: {
        runService: { createRun: mockCreateRun },
        runRepo: { findById: vi.fn() }
      },
      sessionRepo: {
        findById: mockFindById,
        create: mockCreateSession
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
    expect(args.runType).toBe("STANDARD");
    expect(args.sessionId).toBe("sess-affinity-1");
    expect(args.metadata.goal).toBe("do a huge refactor");

    expect(mockCreateSession).toHaveBeenCalledWith({
      id: "sess-affinity-1",
      runId: "run-123",
      agentId: "heidi"
    });
  });

  it("hydrates session state from database if missing in memory", async () => {
    const mockRuntime = {
      services: {
        runService: { createRun: vi.fn() },
        runRepo: {
          findById: vi.fn().mockResolvedValue({
            id: "run-456",
            runType: "PARALLEL_SPECIALISTS",
            status: "running",
            metadata: {
              goal: "hydrated goal",
              lastUserMessageHash: "hash123",
              taskId: "task-456"
            }
          })
        }
      },
      sessionRepo: {
        findById: vi.fn().mockReturnValue({
          id: "sess-hydrate-1",
          runId: "run-456"
        }),
        create: vi.fn()
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
