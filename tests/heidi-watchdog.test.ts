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

  it("watchdog recovery tolerates a sync session.prompt that returns no promise", async () => {
    // Regression: a plugin instance whose client exposes session.prompt as a
    // synchronous function (no Promise) must not crash the watchdog timer with
    // "undefined is not an object (...).catch" when it recovers a stalled
    // session. Repro of the Windows CI test-matrix failure.
    const mockInput = createMockPluginInput() as any;
    mockInput.client = {
      app: { log: async () => {} },
      session: {
        create: async () => ({ data: { id: "s1" } }),
        prompt: () => undefined as any,
        abort: async () => {},
      },
    };
    const pluginInstance = await flowDeckPlugin.server(mockInput);

    // Seed a stalled session (no pending flags, last progress > 60s ago).
    updateWatchdogState("stalled-sync-prompt", {
      hasUnresolvedTask: true,
      lastProgressAt: Date.now() - 120_000,
    });

    // The watchdog interval fires every 10s; give it one tick so the recovery
    // path runs against the sync prompt mock. An unhandled error here would
    // fail the whole run the way it did on Windows CI.
    await new Promise((r) => setTimeout(r, 11_000));

    const state = getWatchdogState("stalled-sync-prompt");
    expect(state).toBeDefined();
    expect(state!.recoveryCount).toBeGreaterThan(0);

    if (pluginInstance.dispose) {
      await pluginInstance.dispose();
    }
  }, 20_000);
});
