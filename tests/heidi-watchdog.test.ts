import { describe, it, expect } from "bun:test";
import { updateWatchdogState, getWatchdogState, clearWatchdogState } from "../src/services/heidi-watchdog";
import flowDeckPlugin from "../src/index";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Project } from "@opencode-ai/sdk";

function createMockPluginInput(): PluginInput {
  return {
    directory: process.cwd(),
    client: { app: { log: async () => {} } } as any, // Deeply nested methods can use test doubles
    project: {
      id: "test-project",
      name: "test-project",
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
      directory: process.cwd(),
      worktree: "main",
    } as Project,
    worktree: "main",
    serverUrl: new URL("http://localhost:8000"),
    experimental_workspace: {
      register: (_type: string, _adapter: any) => {}
    },
    $: Object.assign(
      async () => ({ stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0 } as any),
      {
        braces: () => [],
        escape: (s: string) => s,
        env: function(this: any) { return this },
        cwd: function(this: any) { return this },
        nothrow: function(this: any) { return this },
        throws: function(this: any) { return this }
      }
    ) as any
  };
}


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
    
    const mockInput = createMockPluginInput();
    const pluginInstance = await flowDeckPlugin.server(mockInput);
    
    updateWatchdogState("session-disposed", { isPendingTool: true });
    expect(getWatchdogState("session-disposed")).toBeDefined();

    if (pluginInstance.dispose) {
      await pluginInstance.dispose();
    }

    expect(getWatchdogState("session-disposed")).toBeUndefined();
  });
});
