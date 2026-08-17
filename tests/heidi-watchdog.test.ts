import { describe, it, expect } from "bun:test";
import { updateWatchdogState, getWatchdogState, clearWatchdogState, clearAllWatchdogStates } from "../src/services/heidi-watchdog";
import flowDeckPlugin from "../src/index";

describe("Heidi Watchdog", () => {
  it("creates and updates watchdog state", () => {
    updateWatchdogState("session-1", { isPendingTool: true });
    const state = getWatchdogState("session-1");
    expect(state).toBeDefined();
    expect(state!.isPendingTool).toBe(true);
    expect(state!.recoveryCount).toBe(0);
    expect(state!.recoveryExhausted).toBe(false);
    clearWatchdogState("session-1");
    expect(getWatchdogState("session-1")).toBeUndefined();
  });

  it("handles recovery exhaustion without setting hasUnresolvedTask to false", () => {
    updateWatchdogState("session-2", { hasUnresolvedTask: true, recoveryExhausted: true });
    const state = getWatchdogState("session-2");
    expect(state!.hasUnresolvedTask).toBe(true);
    expect(state!.recoveryExhausted).toBe(true);
    clearWatchdogState("session-2");
  });

  it("clears watchdog state on plugin dispose", async () => {
    const mockClient = { app: { log: async () => {} } };
    const pluginInstance = await flowDeckPlugin.server({ directory: process.cwd(), client: mockClient as any });
    
    updateWatchdogState("session-disposed", { isPendingTool: true });
    expect(getWatchdogState("session-disposed")).toBeDefined();

    if (pluginInstance.dispose) {
      await pluginInstance.dispose();
    }

    expect(getWatchdogState("session-disposed")).toBeUndefined();
  });
});
