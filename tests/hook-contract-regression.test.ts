import { describe, it, expect } from "vitest"
import flowDeckPlugin from "../src/index.js"
import { beforeEach, afterEach } from "vitest"


import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync, rmSync } from "fs"

describe("OpenCode Hook Contract Registration", () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fd-test-hook-"))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("registers experimental.chat.messages.transform and experimental.chat.system.transform", async () => {
    const mockClient = { app: { log: async () => {} } } as any
    const mockProject = {} as any
    const hooks = await flowDeckPlugin.server({
      client: mockClient,
      project: mockProject,
      directory: tmpDir,
      worktree: tmpDir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost"),
      $: {} as any,
    }) as any

    expect(hooks["experimental.chat.messages.transform"]).toBeDefined()
    expect(hooks["experimental.chat.system.transform"]).toBeDefined()
    expect(hooks["chat.message"]).toBeDefined()
  })

  it("chat.message does not mutate messages or system output directly", async () => {
    const mockClient = { app: { log: async () => {} } } as any
    const mockProject = {} as any
    const hooks = await flowDeckPlugin.server({
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

    await hooks["chat.message"]!({ sessionID: "s1" }, outputObj)

    // output.message.messages and output.message.system should NOT be added/mutated by chat.message
    expect(outputObj.message.messages).toBeUndefined()
    expect(outputObj.message.system).toBeUndefined()
  })
})
