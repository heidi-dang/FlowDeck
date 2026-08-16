import { describe, it, expect } from "vitest"
import flowDeckPlugin from "../src/index.js"
import { beforeEach, afterEach } from "vitest"


import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync, rmSync } from "fs"

describe("OpenCode Hook Contract Registration", () => {
  let tmpDir: string
  let pluginInstance: any

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fd-test-hook-"))
    pluginInstance = null
  })
  afterEach(async () => {
    if (pluginInstance?.dispose) {
      try { await pluginInstance.dispose() } catch {}
    }
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it("registers experimental.chat.messages.transform and experimental.chat.system.transform", async () => {
    const mockClient = { app: { log: async () => {} } } as any
    const mockProject = {} as any
    pluginInstance = await flowDeckPlugin.server({
      client: mockClient,
      project: mockProject,
      directory: tmpDir,
      worktree: tmpDir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost"),
      $: {} as any,
    }) as any

    expect(pluginInstance["experimental.chat.messages.transform"]).toBeDefined()
    expect(pluginInstance["experimental.chat.system.transform"]).toBeDefined()
    expect(pluginInstance["chat.message"]).toBeDefined()
  })

  it("chat.message does not mutate messages or system output directly", async () => {
    const mockClient = { app: { log: async () => {} } } as any
    const mockProject = {} as any
    pluginInstance = await flowDeckPlugin.server({
      client: mockClient,
      project: mockProject,
      directory: tmpDir,
      worktree: tmpDir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost"),
      $: {} as any,
    }) as any

    const outputObj: any = {
      message: { agent: "heidi", content: "test user input" }
    }

    await pluginInstance["chat.message"]!({ sessionID: "s1" }, outputObj)

    // output.message.messages and output.message.system should NOT be added/mutated by chat.message
    expect(outputObj.message.messages).toBeUndefined()
    expect(outputObj.message.system).toBeUndefined()
  })
})
