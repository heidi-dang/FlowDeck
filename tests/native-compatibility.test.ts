import { expect, describe, it } from "bun:test"
import plugin from "../src/index"

describe("OpenCode Native Compatibility", () => {
  it("exports a minimal OpenCode plugin", () => {
    expect(plugin.id).toBe("@heidi-dang/flowdeck")
    expect(typeof plugin.server).toBe("function")
  })

  it("does not register duplicate tool loops or custom shells", async () => {
    const hooks = await plugin.server({
      directory: "/tmp",
      project: {} as any,
      worktree: "test" as any,
      serverUrl: {} as any,
      $: (async () => ({} as any)) as any,
      client: { app: { log: async () => {} } } as any
    } as any)
    expect(hooks.tool).toBeDefined()
    expect(hooks.tool?.["shell"]).toBeUndefined()
    expect(hooks.tool?.["bash"]).toBeUndefined()
    expect(hooks.tool?.["read_file"]).toBeUndefined()
    expect(hooks.tool?.["write_file"]).toBeUndefined()
    expect(hooks.tool?.["task"]).toBeUndefined()
  })
})
