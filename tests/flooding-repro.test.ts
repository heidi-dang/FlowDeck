import { describe, it, expect } from "bun:test";
import flowDeckPlugin from "../src/index";

describe("P0 Auto-Continuation Flooding Reproduction", () => {
  it("reproduces the bug: FlowDeck internal prompt triggers chat.message which resets recoveryCount and causes infinite continuation loop", async () => {
    let prompts = 0;
    let handleEvent: any;
    const mockInput: any = {
      directory: process.cwd(),
      client: {
        app: { log: async () => {} },
        session: {
          create: async () => ({ data: { id: "s-flood" } }),
          prompt: (args: any) => {
            prompts++;
            // When session.prompt is called by FlowDeck, OpenCode generates a chat.message event for that prompt:
            handleEvent({
              event: {
                type: "chat.message",
                properties: {
                  sessionID: "s-flood",
                  info: { id: `prompt_msg_${prompts}`, role: "user" },
                  parts: args.body?.parts || [{ type: "text", text: args.body?.parts?.[0]?.text }],
                },
              },
            });
            return Promise.resolve();
          },
        },
      },
      project: { id: "test", name: "test", directory: process.cwd(), worktree: "main" },
      worktree: "main",
      serverUrl: new URL("http://localhost:8000"),
      experimental_workspace: { register: () => {} },
      $: Object.assign(async () => ({ stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0 }), {
        braces: () => [],
        escape: (s: string) => s,
        env: function(this: any) { return this },
        cwd: function(this: any) { return this },
        nothrow: function(this: any) { return this },
        throws: function(this: any) { return this }
      })
    };

    const pluginInstance = await flowDeckPlugin.server(mockInput);
    handleEvent = (pluginInstance as any).event;

    // 1. User manual Continue
    await handleEvent({
      event: {
        type: "chat.message",
        properties: {
          sessionID: "s-flood",
          info: { id: "user_continue", role: "user" },
          parts: [{ type: "text", text: "Continue" }]
        }
      }
    });

    // 2. Assistant produces reasoning-only output (malformed) 10 times consecutively
    for (let i = 1; i <= 10; i++) {
      await handleEvent({
        event: {
          type: "message.updated",
          properties: {
            sessionID: "s-flood",
            info: { id: `msg_malformed_${i}`, role: "assistant", providerID: "test", modelID: "test" },
            parts: [{ type: "reasoning", text: "thinking..." }, { type: "step-finish", reason: "stop" }]
          }
        }
      });
      await new Promise((r) => setTimeout(r, 60)); // allow setTimeout timer to fire
    }

    console.log("Total prompts sent in repro test:", prompts);
    // In buggy code: prompts will be 10 (or > 3) because each internal prompt resets recoveryCount to 0!
    // In fixed code: prompts MUST BE exactly 3 (bounded by MAX_AUTO_CONTINUATIONS_PER_INCIDENT = 3)
    expect(prompts).toBeLessThanOrEqual(3);

    if (pluginInstance.dispose) await pluginInstance.dispose();
  });
});
