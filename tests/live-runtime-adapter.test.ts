import { describe, it, expect, vi } from "vitest";
import { FlowDeckLifecycleAdapter } from "../src/runtime/flowdeck-opencode-adapter";
import type { ProductionOrchestrationRuntime } from "../src/orchestration/composition";

import * as router from "../src/services/heidi-fast-router";

describe("FlowDeckLifecycleAdapter", () => {
  it("creates a Run natively via orchestration services for non-FAST_DIRECT tasks", async () => {
    const mockCreateRun = vi.fn().mockResolvedValue({});
    const mockRuntime = {
      services: {
        runService: {
          createRun: mockCreateRun
        }
      }
    } as unknown as ProductionOrchestrationRuntime;

    const adapter = new FlowDeckLifecycleAdapter("/mock/dir", mockRuntime);
    
    // Send a message that routes to DEEP or STANDARD
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
      { sessionID: "sess-1", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "do a huge refactor", id: "1", sessionID: "sess-1", messageID: "1" }] }
    );

    expect(mockCreateRun).toHaveBeenCalled();
    const args = mockCreateRun.mock.calls[0][0];
    expect(args.runType).toBe("STANDARD");
    expect(args.sessionId).toBe("sess-1");
    expect(args.agentId).toBe("heidi");
  });
});
