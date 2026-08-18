import { describe, it, expect } from "bun:test";
import flowDeckPlugin from "../src/index";
import { getWatchdogState, updateWatchdogState } from "../src/services/heidi-watchdog";
import { recoveryCoordinator } from "../src/services/recovery-coordinator";

describe("Recovery Coordinator & Internal Prompt Provenance (P0 Flood Guard)", () => {
  it("Regression 1: Manual user Continue legitimately resets recovery state", async () => {
    const mockInput: any = {
      directory: process.cwd(),
      client: { app: { log: async () => {} }, session: { prompt: () => Promise.resolve() } },
    };
    const pluginInstance = await flowDeckPlugin.server(mockInput);
    const handleEvent = (pluginInstance as any).event;

    // Seed exhausted session
    updateWatchdogState("s-manual", { recoveryCount: 3, recoveryExhausted: true });
    expect(getWatchdogState("s-manual")?.recoveryExhausted).toBe(true);

    // User sends Continue
    await handleEvent({
      event: {
        type: "chat.message",
        properties: {
          sessionID: "s-manual",
          info: { id: "user-msg-1", role: "user" },
          parts: [{ type: "text", text: "Continue" }],
        },
      },
    });

    const wState = getWatchdogState("s-manual");
    expect(wState?.recoveryExhausted).toBe(false);
    expect(wState?.recoveryCount).toBe(0);

    if (pluginInstance.dispose) await pluginInstance.dispose();
  });

  it("Regression 2: Internal FlowDeck continuation prompt is classified correctly and does NOT reset recovery state", async () => {
    let prompts = 0;
    let handleEvent: any;
    const mockInput: any = {
      directory: process.cwd(),
      client: {
        app: { log: async () => {} },
        session: {
          prompt: (args: any) => {
            prompts++;
            // Simulate OpenCode generating a chat.message for the programmatic prompt
            handleEvent({
              event: {
                type: "chat.message",
                properties: {
                  sessionID: "s-internal",
                  info: { id: `internal_prompt_${prompts}`, role: "user" },
                  parts: args.body?.parts,
                },
              },
            });
            return Promise.resolve({ data: { id: `internal_prompt_${prompts}` } });
          },
        },
      },
    };

    const pluginInstance = await flowDeckPlugin.server(mockInput);
    handleEvent = (pluginInstance as any).event;

    // Trigger reasoning recovery continuation — with confirmed terminal step-finish
    await handleEvent({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s-internal",
          info: { id: "msg_mal_1", role: "assistant", providerID: "p", modelID: "m" },
          parts: [{ type: "reasoning", text: "thinking..." }, { type: "step-finish", reason: "stop" }],
        },
      },
    });

    await new Promise((r) => setTimeout(r, 80));
    expect(prompts).toBe(1);

    const wState = getWatchdogState("s-internal");
    // Recovery count must be 1 (NOT reset to 0 by the internal prompt)
    expect(wState?.recoveryCount).toBe(1);

    if (pluginInstance.dispose) await pluginInstance.dispose();
  });

  it("Regression 3: Enforces at most ONE pending continuation per session", () => {
    let callCount = 0;
    const mockClient = {
      session: {
        prompt: () => {
          callCount++;
          return Promise.resolve();
        },
      },
    };
    const req = {
      sessionID: "s-single-flight",
      source: "reasoning_recovery" as const,
      client: mockClient,
      appLog: async () => {},
      handleEvent: async () => {},
    };

    const first = recoveryCoordinator.requestContinuation(req);
    const second = recoveryCoordinator.requestContinuation(req);

    expect(first).toBe(true);
    expect(second).toBe(false); // Duplicate suppressed!
    expect(callCount).toBe(0);

    recoveryCoordinator.cancelSession("s-single-flight");
  });

  it("Regression 4: Watchdog collision is suppressed when reasoning continuation is pending", () => {
    let promptCalls = 0;
    const mockClient = {
      session: {
        prompt: () => {
          promptCalls++;
          return Promise.resolve();
        },
      },
    };

    const reasoningReq = {
      sessionID: "s-collision",
      source: "reasoning_recovery" as const,
      client: mockClient,
      appLog: async () => {},
      handleEvent: async () => {},
    };

    const watchdogReq = {
      sessionID: "s-collision",
      source: "semantic_watchdog" as const,
      client: mockClient,
      appLog: async () => {},
      handleEvent: async () => {},
    };

    expect(recoveryCoordinator.requestContinuation(reasoningReq)).toBe(true);
    expect(recoveryCoordinator.requestContinuation(watchdogReq)).toBe(false); // Suppressed
    expect(promptCalls).toBe(0);

    recoveryCoordinator.cancelSession("s-collision");
  });

  it("Regression 5: Session cancel/stop clears pending continuation timer and markers", async () => {
    let executed = false;
    const mockClient = {
      session: {
        prompt: () => {
          executed = true;
          return Promise.resolve();
        },
      },
    };

    recoveryCoordinator.requestContinuation({
      sessionID: "s-cancel",
      source: "reasoning_recovery",
      client: mockClient,
      appLog: async () => {},
      handleEvent: async () => {},
    });

    // Cancel immediately before timer fires (50ms debounce)
    recoveryCoordinator.cancelSession("s-cancel");

    await new Promise((r) => setTimeout(r, 80));
    expect(executed).toBe(false);
  });
});
